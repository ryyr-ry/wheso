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
#include "wheso/generated/errors.hpp"
#include "wheso/generated/wire_layout.hpp"

namespace wheso::receiver {

/// 品質低下の警告。文言は利用側が国際化キーから作る（sdk-api.md 6 節）。
inline constexpr const char* DEGRADED_WARNING = "W_DEGRADED";

/// 受信者自身の識別子。転送先は常にこの 1 人である。
inline constexpr std::int64_t SELF_ID = 0;

/// (senderId, channel) ごとの購読状態（state-machines.md 2 節）。
/// AudioOnly は ADR-0029 で追加。映像を落として音声だけを維持する状態である。
enum class StreamPhase { Unsubscribed, Subscribed, Paused, AudioOnly };

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

/// カタログの 1 段。streamCatalog から取り込む（ADR-0027 の 1）。
struct CatalogRung {
  std::int64_t sid = 0;
  std::int64_t width = 0;
  std::int64_t height = 0;
  std::int64_t framerate = 0;
  std::int64_t temporal_layers = 0;
  std::int64_t target_bitrate = 0;
};

/// 送信者 1 人・1 チャネルのはしご。
struct CatalogLadder {
  std::int64_t sender_id = 0;
  std::int64_t channel = 0;
  /// sid の昇順で保持する。
  std::vector<CatalogRung> rungs;
};

struct State {
  /// sender_id, channel の昇順で保持する。反復順序が判断に影響するため決定的にする。
  std::vector<StreamState> streams;
  /// 会議全体のはしご。sender_id, channel の昇順で保持する。
  std::vector<CatalogLadder> catalog;
  bool visible = true;
  std::int64_t target_bytes_per_sec = 0;
  std::optional<std::int64_t> active_speaker_id;
  Slope trend{0, 1};
  bool degraded = false;
  /// 音声だけの状態か（ADR-0029）。
  bool audio_only = false;
  /// 次に減少の判定を行える時刻（AIMD。congestion 4.2）。
  std::int64_t rate_hold_until_ms = 0;
  /// 回復判定が連続した回数。規範は 3 回連続で加算的増加を許す。
  std::int64_t recover_streak = 0;
  /// 目標ビットレートの上限（bytes/sec）。観測した goodput の最大値である。
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
  Goodput,
  ActiveSpeaker,
  Catalog,
  DisplaySize,
  Report,
  Media,
  KeyframeRequest,
  Timer
};

/// 入力イベント。判別共用体を使わず、種類と欄を平坦に持つ（依存を増やさないため）。
struct Event {
  EventKind kind = EventKind::Timer;
  std::vector<SubscribeEntry> entries;
  std::vector<CatalogLadder> catalog_entries;
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

/// 初期状態。引数を取らない。初期値は規範が定める最低の成立点である。
inline State initial_state() {
  const Result<std::int64_t> floor_result = trunc_div(constants::MIN_VIABLE_BPS, 8);
  const std::int64_t floor = floor_result.ok ? floor_result.value : 0;
  State state;
  state.visible = true;
  state.target_bytes_per_sec = floor;
  state.target_ceiling_bytes_per_sec = floor;
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

inline bool is_audio(std::int64_t channel) {
  return channel == static_cast<std::int64_t>(wire_layout::CHANNEL_AUDIO) ||
         channel == static_cast<std::int64_t>(wire_layout::CHANNEL_SCREEN_AUDIO);
}

/// カタログからはしごを引く。
inline const std::vector<CatalogRung>* ladder_of(const State& state, std::int64_t sender_id, std::int64_t channel) {
  for (const CatalogLadder& entry : state.catalog) {
    if (entry.sender_id == sender_id && entry.channel == channel) {
      return &entry.rungs;
    }
  }
  return nullptr;
}

/// 表示寸法から要求すべき段の上限を返す。
/// 規則: 表示幅以上の幅を持つ最小の段。無ければ最上段。未申告（0 以下）は最下段。
inline std::int64_t rung_cap_for(const State& state, const StreamState& stream) {
  const std::vector<CatalogRung>* rungs = ladder_of(state, stream.sender_id, stream.channel);
  if (rungs == nullptr || rungs->empty()) return 0;
  std::int64_t lowest_sid = (*rungs)[0].sid;
  std::int64_t top_sid = (*rungs)[0].sid;
  for (const CatalogRung& rung : *rungs) {
    if (rung.sid < lowest_sid) lowest_sid = rung.sid;
    if (rung.sid > top_sid) top_sid = rung.sid;
  }
  if (stream.display_width <= 0) return lowest_sid;
  std::int64_t best_sid = -1;
  std::int64_t best_width = -1;
  for (const CatalogRung& rung : *rungs) {
    if (rung.width < stream.display_width) continue;
    if (best_sid < 0 || rung.width < best_width) {
      best_sid = rung.sid;
      best_width = rung.width;
    }
  }
  return best_sid < 0 ? top_sid : best_sid;
}

/// 段の費用（bits/sec）。申告が無ければ 0。
inline std::int64_t cost_of(const State& state, const StreamState& stream, std::int64_t sid) {
  const std::vector<CatalogRung>* rungs = ladder_of(state, stream.sender_id, stream.channel);
  if (rungs == nullptr) return 0;
  for (const CatalogRung& rung : *rungs) {
    if (rung.sid == sid) return rung.target_bitrate;
  }
  return 0;
}

/// はしごの最下段。カタログが無ければ 0。
inline std::int64_t lowest_rung(const State& state, const StreamState& stream) {
  const std::vector<CatalogRung>* rungs = ladder_of(state, stream.sender_id, stream.channel);
  if (rungs == nullptr || rungs->empty()) return 0;
  std::int64_t lowest = -1;
  for (const CatalogRung& rung : *rungs) {
    if (lowest < 0 || rung.sid < lowest) lowest = rung.sid;
  }
  return lowest < 0 ? 0 : lowest;
}

/// はしごの最上段。カタログが無ければ 0。
inline std::int64_t highest_rung(const State& state, const StreamState& stream) {
  const std::vector<CatalogRung>* rungs = ladder_of(state, stream.sender_id, stream.channel);
  if (rungs == nullptr || rungs->empty()) return 0;
  std::int64_t top = -1;
  for (const CatalogRung& rung : *rungs) {
    if (rung.sid > top) top = rung.sid;
  }
  return top < 0 ? 0 : top;
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

/// 発話者を先に、次に senderId の昇順で並べる。音声を最優先にする（ADR-0029 の 4）。
inline bool priority_less(const State& state, const StreamState& a, const StreamState& b) {
  // 音声を先に配分する。
  const int a_audio = is_audio(a.channel) ? 0 : 1;
  const int b_audio = is_audio(b.channel) ? 0 : 1;
  if (a_audio != b_audio) return a_audio < b_audio;
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
 * 帯域予算から段を配分する（congestion.md 4.3、ADR-0027、ADR-0029）。
 * 除算は整数で行い、切り捨てる。浮動小数点を使わない（ADR-0017）。
 */
inline StepResult reallocate(const State& state) {
  std::vector<Command> commands;
  // 回線の速度（bits/sec）。
  const std::int64_t link_bps = state.target_bytes_per_sec * 8;
  // 段を買うための予算。ヘッダと制御の余裕を 10% 取る。
  const Result<std::int64_t> budget_result = trunc_div(link_bps * 9, 10);
  const std::int64_t budget_bps = budget_result.ok ? budget_result.value : 0;

  // --- 音声だけの状態への出入り（ヒステリシス。ADR-0029 の 1） ---
  // 判定は回線の速度そのもので行う。10% を引いた予算で判定してはならない。
  const bool audio_only = state.audio_only
    ? link_bps < constants::AUDIO_ONLY_EXIT_BPS
    : link_bps < constants::AUDIO_ONLY_ENTER_BPS;

  if (audio_only) {
    std::vector<StreamState> streams;
    for (const StreamState& stream : state.streams) {
      if (is_audio(stream.channel)) {
        // 音声は維持する。絶対に落としてはならない。
        streams.push_back(stream);
        continue;
      }
      if (stream.phase == StreamPhase::Subscribed) {
        commands.push_back(make_subscribe_change(stream.sender_id, stream.channel, false, 0, 0));
        StreamState updated = stream;
        updated.phase = StreamPhase::AudioOnly;
        streams.push_back(updated);
        continue;
      }
      streams.push_back(stream);
    }
    if (!state.degraded) {
      Command notify;
      notify.kind = CommandKind::Notify;
      notify.code = DEGRADED_WARNING;
      commands.push_back(notify);
    }
    std::sort(streams.begin(), streams.end(), stream_less);
    State next = state;
    next.streams = streams;
    next.audio_only = true;
    next.degraded = true;
    return StepResult{next, commands};
  }

  // --- 映像へ戻す（AUDIO_ONLY から復帰する） ---
  std::vector<StreamState> revived;
  for (const StreamState& stream : state.streams) {
    if (stream.phase == StreamPhase::AudioOnly) {
      StreamState updated = stream;
      updated.phase = StreamPhase::Subscribed;
      updated.spatial_id = lowest_rung(state, stream);
      revived.push_back(updated);
      commands.push_back(make_subscribe_change(stream.sender_id, stream.channel, true,
                                               lowest_rung(state, stream), stream.temporal_id));
      commands.push_back(make_keyframe_request(stream.sender_id, stream.channel,
                                               lowest_rung(state, stream)));
      continue;
    }
    revived.push_back(stream);
  }
  State base = state;
  base.streams = revived;
  base.audio_only = false;

  // --- 予算で段を買う ---
  std::vector<StreamState> ordered;
  for (const StreamState& stream : base.streams) {
    if (stream.phase == StreamPhase::Subscribed) {
      ordered.push_back(stream);
    }
  }
  std::sort(ordered.begin(), ordered.end(),
            [&base](const StreamState& a, const StreamState& b) { return priority_less(base, a, b); });

  // (sender_id, channel) → assigned sid
  std::vector<std::pair<std::int64_t, std::int64_t>> assigned_keys;
  std::vector<std::int64_t> assigned_vals;
  std::int64_t remaining = budget_bps;
  bool degraded = false;

  for (const StreamState& stream : ordered) {
    if (is_audio(stream.channel)) {
      // 音声は段を持たない。費用は予算から引くが、段の選択は行わない。
      remaining -= cost_of(base, stream, 0);
      continue;
    }
    const std::int64_t floor = lowest_rung(base, stream);
    const std::int64_t cap = rung_cap_for(base, stream);
    std::int64_t chosen = floor;
    // 上限から下へ降りて、予算に収まる最も高い段を選ぶ。
    for (std::int64_t sid = cap; sid >= floor; sid -= 1) {
      std::int64_t cost = cost_of(base, stream, sid);
      if (cost <= remaining) {
        chosen = sid;
        break;
      }
    }
    std::int64_t chosen_cost = cost_of(base, stream, chosen);
    if (chosen_cost > remaining) {
      // 最下段さえ入らない。最低保証として最下段を維持し、警告する。
      degraded = true;
    }
    remaining -= chosen_cost;
    assigned_keys.push_back({stream.sender_id, stream.channel});
    assigned_vals.push_back(chosen);
  }

  std::vector<StreamState> streams;
  for (const StreamState& stream : base.streams) {
    std::int64_t next_sid = -1;
    for (std::size_t i = 0; i < assigned_keys.size(); ++i) {
      if (assigned_keys[i].first == stream.sender_id && assigned_keys[i].second == stream.channel) {
        next_sid = assigned_vals[i];
        break;
      }
    }
    if (next_sid < 0 || next_sid == stream.spatial_id) {
      streams.push_back(stream);
      continue;
    }
    commands.push_back(make_set_tier(stream.sender_id, stream.channel, next_sid));
    commands.push_back(make_keyframe_request(stream.sender_id, stream.channel, next_sid));
    StreamState updated = stream;
    updated.spatial_id = next_sid;
    streams.push_back(updated);
  }

  if (degraded && !base.degraded) {
    Command notify;
    notify.kind = CommandKind::Notify;
    notify.code = DEGRADED_WARNING;
    commands.push_back(notify);
  }

  std::sort(streams.begin(), streams.end(), stream_less);
  State next = base;
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
      // 最下段から始める。参加直後に高い段を要求すると詰まるためである（congestion.md 6 節）。
      StreamState dummy;
      dummy.sender_id = entry.sender_id;
      dummy.channel = entry.channel;
      dummy.phase = StreamPhase::Subscribed;
      const std::int64_t start = is_audio(entry.channel) ? 0 : lowest_rung(state, dummy);
      commands.push_back(make_subscribe_change(entry.sender_id, entry.channel, true, start,
                                               entry.max_temporal_id));
      commands.push_back(make_keyframe_request(entry.sender_id, entry.channel, start));
      StreamState created;
      created.sender_id = entry.sender_id;
      created.channel = entry.channel;
      created.phase = StreamPhase::Subscribed;
      created.spatial_id = start;
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

/// カタログの適用。はしごが変わると段の上限と費用が変わるため、配分を作り直す。
inline StepResult handle_catalog(const State& state, const std::vector<CatalogLadder>& entries) {
  std::vector<CatalogLadder> normalized;
  for (const CatalogLadder& entry : entries) {
    CatalogLadder item;
    item.sender_id = entry.sender_id;
    item.channel = entry.channel;
    item.rungs = entry.rungs;
    std::sort(item.rungs.begin(), item.rungs.end(),
              [](const CatalogRung& a, const CatalogRung& b) { return a.sid < b.sid; });
    normalized.push_back(item);
  }
  std::sort(normalized.begin(), normalized.end(), [](const CatalogLadder& a, const CatalogLadder& b) {
    return a.sender_id != b.sender_id ? a.sender_id < b.sender_id : a.channel < b.channel;
  });
  State next = state;
  next.catalog = normalized;
  return reallocate(next);
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
  // 退出者の受信位置とはしごも除去する。残すと居ない相手へ ack を返し続ける。
  next.received.clear();
  for (const ReceivedMark& mark : state.received) {
    if (mark.sender_id != id) {
      next.received.push_back(mark);
    }
  }
  next.catalog.clear();
  for (const CatalogLadder& entry : state.catalog) {
    if (entry.sender_id != id) {
      next.catalog.push_back(entry);
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

/// 遅延の報告に対する応答。規範は 2 つの層を定めている。
///
/// 1. 状態機械（state-machines 3 節）: 遅延勾配が閾値を超えたら tier を 1 段下げる
/// 2. 輻輳制御（congestion 4.2 の AIMD）: target を劣化時に 0.85 倍し、回復が 3 回
///    連続したら RATE_PROBE_BPS を加える（上限を超えない）
///
/// 0.85 は浮動小数点で計算しない。target * 17 / 20 の整数演算とし切り捨てる。
/// 観測した goodput。天井を押し上げ、目標を上げる方向にだけ使う（congestion.md 4.1）。
inline StepResult handle_goodput(const State& state, std::int64_t bytes_per_sec) {
  if (bytes_per_sec <= 0) return StepResult{state, {}};
  const std::int64_t ceiling = bytes_per_sec > state.target_ceiling_bytes_per_sec
                                   ? bytes_per_sec
                                   : state.target_ceiling_bytes_per_sec;
  const std::int64_t raised =
      bytes_per_sec > state.target_bytes_per_sec ? bytes_per_sec : state.target_bytes_per_sec;
  const std::int64_t target = raised > ceiling ? ceiling : raised;
  if (target == state.target_bytes_per_sec && ceiling == state.target_ceiling_bytes_per_sec) {
    return StepResult{state, {}};
  }
  State next = state;
  next.target_bytes_per_sec = target;
  next.target_ceiling_bytes_per_sec = ceiling;
  return reallocate(next);
}

inline StepResult handle_report(const State& state, const std::vector<std::int64_t>& delay_us,
                               std::int64_t t) {
  // 標本が 2 個未満では勾配が定まらない。定まらない値で AIMD を動かしてはならない。
  if (delay_us.size() < 2) return StepResult{state, {}};
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
      const std::int64_t lowered = reduced.ok ? reduced.value : target;
      // 予兆で最低成立点を割らない（ADR-0040）
      const Result<std::int64_t> floor_result = trunc_div(constants::MIN_VIABLE_BPS, 8);
      const std::int64_t floor = floor_result.ok ? floor_result.value : 0;
      target = lowered < floor ? floor : lowered;
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

  State after_rate = state;
  after_rate.trend = trend;
  after_rate.target_bytes_per_sec = target;
  after_rate.rate_hold_until_ms = hold_until;
  after_rate.recover_streak = streak;

  if (!degrading && !recovering) {
    return StepResult{after_rate, {}};
  }

  // --- 状態機械（state-machines.md 3 節）。tier を 1 段動かす ---
  const std::int64_t delta = degrading ? -1 : 1;
  std::vector<Command> commands;
  std::vector<StreamState> streams;
  for (const StreamState& stream : after_rate.streams) {
    if (stream.phase != StreamPhase::Subscribed || is_audio(stream.channel)) {
      // 音声には段が無い。輻輳でも音声の段を動かしてはならない。
      streams.push_back(stream);
      continue;
    }
    const std::int64_t floor = lowest_rung(after_rate, stream);
    // 上限は「表示寸法から決まる段」である。勾配が回復しても表示が小さいままなら上げない。
    const std::int64_t cap = rung_cap_for(after_rate, stream);
    std::int64_t raw = stream.spatial_id + delta;
    std::int64_t next_spatial = raw < floor ? floor : (raw > cap ? cap : raw);
    if (next_spatial == stream.spatial_id) {
      streams.push_back(stream);
      continue;
    }
    StreamState updated = stream;
    updated.spatial_id = next_spatial;
    streams.push_back(updated);
    commands.push_back(make_set_tier(stream.sender_id, stream.channel, next_spatial));
    // 段が変わるとエンコーダの別ストリームへ切り替わるためキーフレームが必要である。
    commands.push_back(make_keyframe_request(stream.sender_id, stream.channel, next_spatial));
  }
  after_rate.streams = streams;
  return StepResult{after_rate, commands};
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
      // goodput は上限の推定には使わない。観測した最大で天井を押し上げるだけにする。
      State next = state;
      next.target_bytes_per_sec = event.bytes_per_sec;
      if (event.bytes_per_sec > state.target_ceiling_bytes_per_sec) {
        next.target_ceiling_bytes_per_sec = event.bytes_per_sec;
      }
      return detail::reallocate(next);
    }
    case EventKind::ActiveSpeaker: {
      State next = state;
      next.active_speaker_id = event.speaker_id;
      return detail::reallocate(next);
    }
    case EventKind::Catalog:
      return detail::handle_catalog(state, event.catalog_entries);
    case EventKind::DisplaySize:
      return detail::handle_display_size(state, event.sender_id, event.channel, event.width);
    case EventKind::Report:
      return detail::handle_report(state, event.delay_us, t);
    case EventKind::Goodput:
      return detail::handle_goodput(state, event.bytes_per_sec);
    case EventKind::Media:
      return detail::handle_media(state, event);
    case EventKind::KeyframeRequest: {
      // 判断は無い。要求をコマンドへ直すだけである（間隔制限は実行側）。
      Command kf_req = detail::make_keyframe_request(event.sender_id, event.channel, event.sid);
      return StepResult{state, {kf_req}};
    }
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
