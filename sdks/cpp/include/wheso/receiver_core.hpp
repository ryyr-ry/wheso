// 受信ノード（receiver）の判断コア（C++）。
//
// 規範: state-machines.md 2 節（購読と tier）、congestion.md 4.3（tier の選択）。
// TypeScript の参照実装（packages/core/src/receiver-core.ts）と**同一の出力**を返さなければ
// ならない。照合は凍結トレース（spec/vectors/trace-receiver.jsonl）で行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻・乱数・浮動小数点・入出力に触れない。除算は整数の切り捨てのみを使う。
#pragma once

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "wheso/fixed.hpp"
#include "wheso/generated/constants.hpp"

namespace wheso::receiver {

/// 品質低下の警告。文言は利用側が国際化キーから作る（sdk-api.md 6 節）。
inline constexpr const char* DEGRADED_WARNING = "W_DEGRADED";

/// 受信者自身の識別子。転送先は常にこの 1 人である。
inline constexpr std::int64_t SELF_ID = 0;

/// (senderId, channel) ごとの購読状態（state-machines.md 2 節）。
enum class StreamPhase { Unsubscribed, Subscribed, Paused };

struct StreamState {
  std::int64_t sender_id = 0;
  std::int64_t channel = 0;
  StreamPhase phase = StreamPhase::Unsubscribed;
  /// 現在要求している最大 spatialId。
  std::int64_t spatial_id = 0;
  /// 現在要求している最大 temporalId。
  std::int64_t temporal_id = 0;
  /// 利用側が申告した表示寸法（論理画素）。未申告は 0。
  std::int64_t display_width = 0;
};

/// 受信済みの位置。ack の内容になる。
struct ReceivedMark {
  std::int64_t sender_id = 0;
  std::int64_t channel = 0;
  std::int64_t spatial_id = 0;
  std::int64_t highest_seq = 0;
};

struct State {
  /// sender_id, channel の昇順で保持する。反復順序が判断に影響するため決定的にする。
  std::vector<StreamState> streams;
  bool visible = true;
  std::int64_t target_bytes_per_sec = 0;
  std::optional<std::int64_t> active_speaker_id;
  Slope trend{0, 1};
  bool degraded = false;
  /// 次に減少の判定を行える時刻（AIMD。congestion 4.2）。
  std::int64_t rate_hold_until_ms = 0;
  /// 回復判定が連続した回数。規範は 3 回連続で加算的増加を許す。
  std::int64_t recover_streak = 0;
  /// 目標ビットレートの上限（bytes/sec）。加算的増加はこれを超えない。
  std::int64_t target_ceiling_bytes_per_sec = 0;
  std::vector<std::string> unexpected_events;
  /// sender_id, channel, spatial_id の昇順で保持する。
  std::vector<ReceivedMark> received;
};

struct SubscribeEntry {
  std::int64_t sender_id = 0;
  std::int64_t channel = 0;
  std::int64_t max_spatial_id = 0;
  std::int64_t max_temporal_id = 0;
};

enum class EventKind {
  SubscribeList,
  Leave,
  Visibility,
  Budget,
  ActiveSpeaker,
  DisplaySize,
  Report,
  Media,
  Timer
};

/// 入力イベント。判別共用体を使わず、種類と欄を平坦に持つ（依存を増やさないため）。
struct Event {
  EventKind kind = EventKind::Timer;
  std::vector<SubscribeEntry> entries;
  std::int64_t id = 0;
  bool visible = false;
  std::int64_t bytes_per_sec = 0;
  std::optional<std::int64_t> speaker_id;
  std::int64_t sender_id = 0;
  std::int64_t channel = 0;
  std::int64_t width = 0;
  std::vector<std::int64_t> delay_us;
  std::int64_t from = 0;
  std::int64_t ch = 0;
  std::int64_t sid = 0;
  std::int64_t tid = 0;
  std::int64_t seq = 0;
};

enum class CommandKind { SubscribeChange, KeyframeRequest, SetTier, Forward, Drop, Notify, Ack };

struct Command {
  CommandKind kind = CommandKind::Forward;
  std::int64_t to = 0;
  std::int64_t channel = 0;
  bool want = false;
  std::int64_t max_spatial_id = 0;
  std::int64_t max_temporal_id = 0;
  std::int64_t target_id = 0;
  std::int64_t spatial_id = 0;
  std::int64_t tier = 0;
  std::vector<std::int64_t> forward_to;
  std::int64_t priority = 0;
  std::int64_t count = 0;
  std::string code;
  std::int64_t sender_id = 0;
  std::int64_t highest_seq = 0;
};

struct StepResult {
  State state;
  std::vector<Command> commands;
};

inline State initial_state(std::int64_t target_bytes_per_sec) {
  State state;
  state.visible = true;
  state.target_bytes_per_sec = target_bytes_per_sec;
  // 初めに与えられた値が上限である。回復してもこれを超えて要求しない。
  state.target_ceiling_bytes_per_sec = target_bytes_per_sec;
  state.trend = Slope{0, 1};
  return state;
}

namespace detail {

inline bool stream_less(const StreamState& a, const StreamState& b) {
  if (a.sender_id != b.sender_id) {
    return a.sender_id < b.sender_id;
  }
  return a.channel < b.channel;
}

inline const StreamState* find_stream(const State& state, std::int64_t sender_id, std::int64_t channel) {
  for (const StreamState& stream : state.streams) {
    if (stream.sender_id == sender_id && stream.channel == channel) {
      return &stream;
    }
  }
  return nullptr;
}

/// spatialId の範囲は最低品質から最高品質までである。
inline std::int64_t clamp_spatial(std::int64_t value) {
  if (value < constants::V_360P15_SPATIAL_ID) {
    return constants::V_360P15_SPATIAL_ID;
  }
  if (value > constants::V_4K60_SPATIAL_ID) {
    return constants::V_4K60_SPATIAL_ID;
  }
  return value;
}

inline Command make_subscribe_change(std::int64_t to, std::int64_t channel, bool want,
                                     std::int64_t max_spatial_id, std::int64_t max_temporal_id) {
  Command command;
  command.kind = CommandKind::SubscribeChange;
  command.to = to;
  command.channel = channel;
  command.want = want;
  command.max_spatial_id = max_spatial_id;
  command.max_temporal_id = max_temporal_id;
  return command;
}

inline Command make_keyframe_request(std::int64_t target_id, std::int64_t channel, std::int64_t spatial_id) {
  Command command;
  command.kind = CommandKind::KeyframeRequest;
  command.target_id = target_id;
  command.channel = channel;
  command.spatial_id = spatial_id;
  return command;
}

inline Command make_set_tier(std::int64_t target_id, std::int64_t channel, std::int64_t tier) {
  Command command;
  command.kind = CommandKind::SetTier;
  command.target_id = target_id;
  command.channel = channel;
  command.tier = tier;
  return command;
}

/// 発話者を先に、次に senderId の昇順で並べる。順序は決定的でなければならない。
inline bool priority_less(const State& state, const StreamState& a, const StreamState& b) {
  const int a_speaker = (state.active_speaker_id.has_value() && state.active_speaker_id.value() == a.sender_id) ? 0 : 1;
  const int b_speaker = (state.active_speaker_id.has_value() && state.active_speaker_id.value() == b.sender_id) ? 0 : 1;
  if (a_speaker != b_speaker) {
    return a_speaker < b_speaker;
  }
  if (a.sender_id != b.sender_id) {
    return a.sender_id < b.sender_id;
  }
  return a.channel < b.channel;
}

/**
 * 帯域予算から tier を配分する（congestion.md 4.3）。
 * 除算は整数で行い、切り捨てる。浮動小数点を使わない（ADR-0017）。
 */
inline StepResult reallocate(const State& state) {
  std::vector<Command> commands;
  const Result<std::int64_t> budget_result = trunc_div(state.target_bytes_per_sec * 8 * 9, 10);
  const std::int64_t budget_bps = budget_result.ok ? budget_result.value : 0;
  const Result<std::int64_t> high_result = trunc_div(budget_bps, constants::V_4K60_TARGET_BITRATE);
  const std::int64_t high_quality_count = high_result.ok ? high_result.value : 0;
  const std::int64_t thumbnail_cost = constants::V_360P15_TARGET_BITRATE;

  std::vector<StreamState> ordered;
  for (const StreamState& stream : state.streams) {
    if (stream.phase == StreamPhase::Subscribed) {
      ordered.push_back(stream);
    }
  }
  std::sort(ordered.begin(), ordered.end(),
            [&state](const StreamState& a, const StreamState& b) { return priority_less(state, a, b); });

  std::vector<StreamState> streams;
  std::int64_t assigned_high = 0;
  std::int64_t remaining = budget_bps;
  bool degraded = false;

  for (const StreamState& stream : state.streams) {
    if (stream.phase != StreamPhase::Subscribed) {
      streams.push_back(stream);
      continue;
    }
    std::int64_t rank = -1;
    for (std::size_t index = 0; index < ordered.size(); index += 1) {
      if (ordered[index].sender_id == stream.sender_id && ordered[index].channel == stream.channel) {
        rank = static_cast<std::int64_t>(index);
        break;
      }
    }
    std::int64_t next_spatial = 0;
    if (stream.display_width == 0) {
      // 表示寸法の申告が無い相手は最低品質に留める（ADR-0015）。
      next_spatial = constants::DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID;
    } else if (assigned_high < high_quality_count && rank < high_quality_count) {
      next_spatial = constants::V_4K60_SPATIAL_ID;
      assigned_high += 1;
      remaining -= constants::V_4K60_TARGET_BITRATE;
    } else if (remaining >= thumbnail_cost) {
      next_spatial = constants::V_360P15_SPATIAL_ID;
      remaining -= thumbnail_cost;
    } else {
      // 予算が尽きた。発話者のサムネイルのみを維持する（最低保証）。
      next_spatial = constants::V_360P15_SPATIAL_ID;
      degraded = true;
    }
    if (next_spatial != stream.spatial_id) {
      commands.push_back(make_set_tier(stream.sender_id, stream.channel, next_spatial));
      if (next_spatial > stream.spatial_id) {
        // spatialId が上がる場合はエンコーダ出力が切り替わるためキーフレームが必要である。
        commands.push_back(make_keyframe_request(stream.sender_id, stream.channel, next_spatial));
      }
    }
    StreamState updated = stream;
    updated.spatial_id = next_spatial;
    streams.push_back(updated);
  }

  if (degraded && !state.degraded) {
    // 最低保証（発話者のサムネイル 1 本と全員の音声）を下回った。利用側へ警告する。
    Command notify;
    notify.kind = CommandKind::Notify;
    notify.code = DEGRADED_WARNING;
    commands.push_back(notify);
  }

  State next = state;
  std::sort(streams.begin(), streams.end(), stream_less);
  next.streams = streams;
  next.degraded = degraded;
  return StepResult{next, commands};
}

/// 購読一覧の適用。表 1 行目と 2 行目に対応する。
inline StepResult handle_subscribe_list(const State& state, const std::vector<SubscribeEntry>& entries) {
  std::vector<Command> commands;
  std::vector<StreamState> kept;

  std::vector<SubscribeEntry> sorted = entries;
  std::sort(sorted.begin(), sorted.end(), [](const SubscribeEntry& a, const SubscribeEntry& b) {
    if (a.sender_id != b.sender_id) {
      return a.sender_id < b.sender_id;
    }
    return a.channel < b.channel;
  });

  for (const SubscribeEntry& entry : sorted) {
    const StreamState* existing = find_stream(state, entry.sender_id, entry.channel);
    const bool unsubscribed = existing == nullptr || existing->phase == StreamPhase::Unsubscribed;
    if (unsubscribed) {
      commands.push_back(make_subscribe_change(entry.sender_id, entry.channel, true, entry.max_spatial_id,
                                               entry.max_temporal_id));
      commands.push_back(make_keyframe_request(entry.sender_id, entry.channel, entry.max_spatial_id));
      StreamState created;
      created.sender_id = entry.sender_id;
      created.channel = entry.channel;
      created.phase = StreamPhase::Subscribed;
      created.spatial_id = entry.max_spatial_id;
      created.temporal_id = entry.max_temporal_id;
      created.display_width = existing == nullptr ? 0 : existing->display_width;
      kept.push_back(created);
      continue;
    }
    StreamState updated = *existing;
    updated.phase = StreamPhase::Subscribed;
    kept.push_back(updated);
  }

  // 一覧から外れたものは購読解除する（表 2 行目）。
  for (const StreamState& stream : state.streams) {
    bool still_wanted = false;
    for (const SubscribeEntry& entry : entries) {
      if (entry.sender_id == stream.sender_id && entry.channel == stream.channel) {
        still_wanted = true;
        break;
      }
    }
    if (!still_wanted && stream.phase != StreamPhase::Unsubscribed) {
      commands.push_back(make_subscribe_change(stream.sender_id, stream.channel, false, 0, 0));
    }
  }

  State next = state;
  std::sort(kept.begin(), kept.end(), stream_less);
  next.streams = kept;
  StepResult after = reallocate(next);
  std::vector<Command> merged = commands;
  for (const Command& command : after.commands) {
    merged.push_back(command);
  }
  return StepResult{after.state, merged};
}

/// 送信者の退出。表 6 行目に対応する。
inline StepResult handle_leave(const State& state, std::int64_t id) {
  std::vector<StreamState> streams;
  for (const StreamState& stream : state.streams) {
    if (stream.sender_id != id) {
      streams.push_back(stream);
    }
  }
  if (streams.size() == state.streams.size()) {
    return StepResult{state, {}};
  }
  State next = state;
  next.streams = streams;
  // 退出者の受信位置も除去する。残すと居ない相手へ ack を返し続ける。
  next.received.clear();
  for (const ReceivedMark& mark : state.received) {
    if (mark.sender_id != id) {
      next.received.push_back(mark);
    }
  }
  return reallocate(next);
}

/// 表示・非表示。表 7 行目と 8 行目に対応する。
inline StepResult handle_visibility(const State& state, bool visible) {
  if (visible == state.visible) {
    return StepResult{state, {}};
  }
  std::vector<Command> commands;
  std::vector<StreamState> streams;
  for (const StreamState& stream : state.streams) {
    if (!visible && stream.phase == StreamPhase::Subscribed) {
      // 非表示では購読を解除するが、状態は保持する（PAUSED）。
      commands.push_back(make_subscribe_change(stream.sender_id, stream.channel, false, 0, 0));
      StreamState paused = stream;
      paused.phase = StreamPhase::Paused;
      streams.push_back(paused);
      continue;
    }
    if (visible && stream.phase == StreamPhase::Paused) {
      commands.push_back(make_subscribe_change(stream.sender_id, stream.channel, true, stream.spatial_id,
                                               stream.temporal_id));
      commands.push_back(make_keyframe_request(stream.sender_id, stream.channel, stream.spatial_id));
      StreamState resumed = stream;
      resumed.phase = StreamPhase::Subscribed;
      streams.push_back(resumed);
      continue;
    }
    streams.push_back(stream);
  }
  State next = state;
  next.visible = visible;
  next.streams = streams;
  return StepResult{next, commands};
}

/// 表示寸法の申告。未申告の相手は最低品質に留める（ADR-0015）。
inline StepResult handle_display_size(const State& state, std::int64_t sender_id, std::int64_t channel,
                                      std::int64_t width) {
  if (find_stream(state, sender_id, channel) == nullptr) {
    State next = state;
    next.unexpected_events.push_back("displaySize");
    return StepResult{next, {}};
  }
  State next = state;
  next.streams.clear();
  for (const StreamState& stream : state.streams) {
    StreamState updated = stream;
    if (stream.sender_id == sender_id && stream.channel == channel) {
      updated.display_width = width;
    }
    next.streams.push_back(updated);
  }
  return reallocate(next);
}

/// 測定報告。勾配が劣化閾値を超えたら tier を 1 段下げ、回復閾値を下回ったら 1 段上げる。
/// 遅延の報告に対する応答。規範は 2 つの層を定めている。
///
/// 1. 状態機械（state-machines 3 節）: 遅延勾配が閾値を超えたら tier を 1 段下げる
/// 2. 輻輳制御（congestion 4.2 の AIMD）: target を劣化時に 0.85 倍し、回復が 3 回
///    連続したら RATE_PROBE_BPS を加える（上限を超えない）
///
/// 0.85 は浮動小数点で計算しない。target * 17 / 20 の整数演算とし切り捨てる。
inline StepResult handle_report(const State& state, const std::vector<std::int64_t>& delay_us,
                               std::int64_t t) {
  const Slope trend = delay_slope(delay_us);
  const bool degrading =
      trend.numerator * constants::SHARD_TREND_ENTER_T2_DEN >
      constants::SHARD_TREND_ENTER_T2_NUM * trend.denominator;
  const bool recovering =
      trend.numerator * constants::SHARD_TREND_EXIT_DEN < constants::SHARD_TREND_EXIT_NUM * trend.denominator;

  // --- AIMD。target を更新する ---
  std::int64_t target = state.target_bytes_per_sec;
  std::int64_t hold_until = state.rate_hold_until_ms;
  std::int64_t streak = state.recover_streak;
  if (degrading) {
    streak = 0;
    // 待ちの間は減らさない。1 回の揺れで連続して落とさないためである。
    if (t >= state.rate_hold_until_ms) {
      const Result<std::int64_t> reduced = trunc_div(target * 17, 20);
      if (reduced.ok) {
        target = reduced.value;
      }
      hold_until = t + constants::RATE_HOLD_MS;
    }
  } else if (recovering) {
    streak = state.recover_streak + 1;
    if (streak >= constants::RATE_RECOVER_STREAK) {
      const Result<std::int64_t> increment = trunc_div(constants::RATE_PROBE_BPS, 8);
      const std::int64_t raised = target + (increment.ok ? increment.value : 0);
      target = raised > state.target_ceiling_bytes_per_sec ? state.target_ceiling_bytes_per_sec : raised;
      streak = 0;
    }
  } else {
    streak = 0;
  }

  if (!degrading && !recovering) {
    State next = state;
    next.trend = trend;
    next.target_bytes_per_sec = target;
    next.rate_hold_until_ms = hold_until;
    next.recover_streak = streak;
    return StepResult{next, {}};
  }
  const std::int64_t delta = degrading ? -1 : 1;
  std::vector<Command> commands;
  std::vector<StreamState> streams;
  for (const StreamState& stream : state.streams) {
    if (stream.phase != StreamPhase::Subscribed) {
      streams.push_back(stream);
      continue;
    }
    const std::int64_t next_spatial = clamp_spatial(stream.spatial_id + delta);
    if (next_spatial == stream.spatial_id) {
      streams.push_back(stream);
      continue;
    }
    StreamState updated = stream;
    updated.spatial_id = next_spatial;
    streams.push_back(updated);
    commands.push_back(make_set_tier(stream.sender_id, stream.channel, next_spatial));
    // spatialId が変わる場合のみキーフレームを要求する（表 4 行目と 3 行目の違い）。
    if (next_spatial > stream.spatial_id) {
      commands.push_back(make_keyframe_request(stream.sender_id, stream.channel, next_spatial));
    }
  }
  State next = state;
  next.trend = trend;
  next.streams = streams;
  return StepResult{next, commands};
}

/// 受信した位置を更新する。後戻りする値では更新しない。
inline State mark_received(const State& state, const Event& event) {
  if (event.seq <= 0) {
    return state;
  }
  for (const ReceivedMark& mark : state.received) {
    if (mark.sender_id == event.from && mark.channel == event.ch && mark.spatial_id == event.sid) {
      if (mark.highest_seq >= event.seq) {
        return state;
      }
      break;
    }
  }
  State next = state;
  next.received.clear();
  for (const ReceivedMark& mark : state.received) {
    if (!(mark.sender_id == event.from && mark.channel == event.ch && mark.spatial_id == event.sid)) {
      next.received.push_back(mark);
    }
  }
  next.received.push_back(ReceivedMark{event.from, event.ch, event.sid, event.seq});
  std::sort(next.received.begin(), next.received.end(), [](const ReceivedMark& a, const ReceivedMark& b) {
    if (a.sender_id != b.sender_id) {
      return a.sender_id < b.sender_id;
    }
    if (a.channel != b.channel) {
      return a.channel < b.channel;
    }
    return a.spatial_id < b.spatial_id;
  });
  return next;
}

/// メディアの転送。要求 tier を超えるユニットは転送しない。
inline StepResult handle_media(const State& state, const Event& event) {
  const StreamState* stream = find_stream(state, event.from, event.ch);
  if (stream == nullptr || stream->phase != StreamPhase::Subscribed) {
    return StepResult{state, {}};
  }
  if (event.sid > stream->spatial_id || event.tid > stream->temporal_id) {
    Command drop;
    drop.kind = CommandKind::Drop;
    drop.priority = 1;
    drop.count = 1;
    return StepResult{state, {drop}};
  }
  // 受信した位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
  Command forward;
  forward.kind = CommandKind::Forward;
  forward.forward_to.push_back(SELF_ID);
  return StepResult{mark_received(state, event), {forward}};
}

}  // namespace detail

/// 純関数の状態遷移。
/// 純関数の状態遷移。時刻は AIMD の待ち（RATE_HOLD_MS）に使う。
inline StepResult step(const State& state, const Event& event, std::int64_t t = 0) {
  switch (event.kind) {
    case EventKind::SubscribeList:
      return detail::handle_subscribe_list(state, event.entries);
    case EventKind::Leave:
      return detail::handle_leave(state, event.id);
    case EventKind::Visibility:
      return detail::handle_visibility(state, event.visible);
    case EventKind::Budget: {
      State next = state;
      next.target_bytes_per_sec = event.bytes_per_sec;
      return detail::reallocate(next);
    }
    case EventKind::ActiveSpeaker: {
      State next = state;
      next.active_speaker_id = event.speaker_id;
      return detail::reallocate(next);
    }
    case EventKind::DisplaySize:
      return detail::handle_display_size(state, event.sender_id, event.channel, event.width);
    case EventKind::Report:
      return detail::handle_report(state, event.delay_us, t);
    case EventKind::Media:
      return detail::handle_media(state, event);
    case EventKind::Timer: {
      // ACK_INTERVAL_MS ごとに、受信済みの位置を ack として返す。
      // 呼び出し側が周期を管理する（コアは時刻を持たない）。
      std::vector<Command> commands;
      for (const ReceivedMark& mark : state.received) {
        Command ack;
        ack.kind = CommandKind::Ack;
        ack.sender_id = mark.sender_id;
        ack.channel = mark.channel;
        ack.spatial_id = mark.spatial_id;
        ack.highest_seq = mark.highest_seq;
        commands.push_back(ack);
      }
      return StepResult{state, commands};
    }
  }
  return StepResult{state, {}};
}

}  // namespace wheso::receiver
