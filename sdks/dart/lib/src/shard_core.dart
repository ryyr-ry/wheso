// 中継ノード（shard）の判断コア（Dart）。
//
// TypeScript の参照実装（packages/core/src/shard-core.ts）と**同じ入力列から同じ出力列**を
// 返さなければならない（conformance.md 2 節の層 2）。検証は凍結トレースベクタで行う。
//
// sans-IO。時刻は入力として受け取り、内部で取得しない。
// 浮動小数点を使わない。例外を投げない。
//
// 設計の要点は 3 つである。
//
// 1. 判断は購読ごとに独立している。遅い受信者 1 人が他の受信者の品質を落としてはならない。
// 2. 送信窓が破棄を有効にする唯一の機構である。
// 3. 解像度方向は simulcast であり、購読者へ渡すのはちょうど 1 段である。

import 'fixed.dart' show delaySlope, Slope;
import 'generated/constants.dart' as constants;
import 'generated/errors.dart' as errors;
import 'generated/wire_layout.dart' as wire_layout;
import 'wire.dart' show dropPriority;

// ---------------------------------------------------------------------------
// 輻輳状態（state-machines.md 3 節）
// ---------------------------------------------------------------------------

enum Congestion {
  normal,
  sheddingT2,
  sheddingT1,
  sheddingSpatial,
  keyOnly,
}

// ---------------------------------------------------------------------------
// 入力イベント（conformance.md 4.2）
// ---------------------------------------------------------------------------

sealed class ShardEvent {}

class MediaEvent implements ShardEvent {
  const MediaEvent({
    required this.from,
    required this.ch,
    required this.sid,
    required this.tid,
    required this.key,
    required this.bytes,
    required this.flags,
    required this.seq,
  });
  final int from;
  final int ch;
  final int sid;
  final int tid;
  final bool key;
  final int bytes;
  final int flags;
  /// ワイヤの sequenceNumber。送信窓の計算に使う。
  final int seq;
}

class SubscribeEvent implements ShardEvent {
  const SubscribeEvent({
    required this.from,
    required this.to,
    required this.ch,
    required this.want,
    required this.maxSpatialId,
    required this.maxTemporalId,
  });
  final int from;
  final int to;
  /// 購読するチャネル。購読は (subscriberId, targetId, channel) で一意。
  final int ch;
  final bool want;
  final int maxSpatialId;
  final int maxTemporalId;
}

/// 受信側からの受信位置の通知（congestion.md 2 節）。
class AckEvent implements ShardEvent {
  const AckEvent({
    required this.from,
    required this.to,
    required this.ch,
    required this.sid,
    required this.highestSeq,
  });
  final int from;
  final int to;
  final int ch;
  /// どの段に対する ack か。段ごとに seq 空間が独立している。
  final int sid;
  final int highestSeq;
}

/// はしごの 1 段（ADR-0026）。
class LadderRung {
  const LadderRung({
    required this.sid,
    required this.width,
    required this.height,
    required this.framerate,
    required this.temporalLayers,
    required this.targetBitrate,
  });
  final int sid;
  final int width;
  final int height;
  final int framerate;
  final int temporalLayers;
  final int targetBitrate;
}

/// 送信者が申告したはしご（wire-format.md 2.3、ADR-0026）。
class StreamAnnounceEvent implements ShardEvent {
  const StreamAnnounceEvent({
    required this.from,
    required this.ch,
    required this.rungs,
  });
  final int from;
  final int ch;
  final List<LadderRung> rungs;
}

class JoinEvent implements ShardEvent {
  const JoinEvent({required this.id});
  final int id;
}

class LeaveEvent implements ShardEvent {
  const LeaveEvent({required this.id});
  final int id;
}

class LinkEvent implements ShardEvent {
  const LinkEvent({required this.peer, required this.state});
  final int peer;
  final String state;
}

class TimerEvent implements ShardEvent {
  const TimerEvent();
}

class BudgetEvent implements ShardEvent {
  const BudgetEvent({required this.bytesPerSec});
  final int bytesPerSec;
}

class ReportEvent implements ShardEvent {
  const ReportEvent({required this.from, required this.delayUs});
  final int from;
  final List<int> delayUs;
}

/// 購読者からのキーフレーム要求（ADR-0039）。
/// 購読していない相手への要求は無視して記録する。
class KeyframeRequestEvent implements ShardEvent {
  const KeyframeRequestEvent({
    required this.from,
    required this.target,
    required this.ch,
    required this.sid,
  });
  final int from;
  final int target;
  final int ch;
  final int sid;
}

// ---------------------------------------------------------------------------
// 出力コマンド（conformance.md 4.3）
// ---------------------------------------------------------------------------

sealed class ShardCommand {}

class ForwardCommand implements ShardCommand {
  const ForwardCommand({required this.to});
  final List<int> to;
}

class DropCommand implements ShardCommand {
  const DropCommand({required this.priority, required this.count});
  final int priority;
  final int count;
}

class SetTierCommand implements ShardCommand {
  const SetTierCommand({required this.targetId, required this.tier});
  final int targetId;
  final int tier;
}

class KeyframeRequestCommand implements ShardCommand {
  /// キーフレームの要求。段ごとに符号化器が別であるため channel と spatialId を持つ（ADR-0033）。
  const KeyframeRequestCommand({
    required this.targetId,
    required this.channel,
    required this.spatialId,
  });
  final int targetId;
  final int channel;
  final int spatialId;
}

/// 上流（送信ノード）へ返す受信位置。これが無いと送信ノードの送信窓が開かない。
class AckUpstreamCommand implements ShardCommand {
  const AckUpstreamCommand({
    required this.to,
    required this.channel,
    required this.spatialId,
    required this.highestSeq,
  });
  final int to;
  final int channel;
  final int spatialId;
  final int highestSeq;
}

/// 受け取った位置。ackUpstream の内容になる。
class ReceivedMark {
  const ReceivedMark({required this.from, required this.ch, required this.sid, required this.highestSeq});
  final int from;
  final int ch;
  final int sid;
  final int highestSeq;
}

class DisconnectCommand implements ShardCommand {
  const DisconnectCommand({required this.peer});
  final int peer;
}

class NotifyCommand implements ShardCommand {
  const NotifyCommand({required this.code});
  final int code;
}

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

/// 購読 1 本の状態。判断はすべてここに閉じる。
class Subscription {
  const Subscription({
    required this.subscriberId,
    required this.targetId,
    required this.channel,
    required this.maxSpatialId,
    required this.maxTemporalId,
    required this.windowSid,
    required this.highestSent,
    required this.highestAcked,
    required this.lastAckAtMs,
    required this.stalled,
    required this.congestion,
    required this.congestionEnteredAt,
    required this.tierPenalty,
  });
  final int subscriberId;
  final int targetId;
  final int channel;
  final int maxSpatialId;
  final int maxTemporalId;
  /// 送信窓が追跡している段。-1 は「まだ渡していない」。
  final int windowSid;
  final int highestSent;
  final int highestAcked;
  final int lastAckAtMs;
  final bool stalled;
  final Congestion congestion;
  final int congestionEnteredAt;
  /// 輻輳による段の引き下げ量。
  final int tierPenalty;

  Subscription copyWith({
    int? maxSpatialId,
    int? maxTemporalId,
    int? windowSid,
    int? highestSent,
    int? highestAcked,
    int? lastAckAtMs,
    bool? stalled,
    Congestion? congestion,
    int? congestionEnteredAt,
    int? tierPenalty,
  }) {
    return Subscription(
      subscriberId: subscriberId,
      targetId: targetId,
      channel: channel,
      maxSpatialId: maxSpatialId ?? this.maxSpatialId,
      maxTemporalId: maxTemporalId ?? this.maxTemporalId,
      windowSid: windowSid ?? this.windowSid,
      highestSent: highestSent ?? this.highestSent,
      highestAcked: highestAcked ?? this.highestAcked,
      lastAckAtMs: lastAckAtMs ?? this.lastAckAtMs,
      stalled: stalled ?? this.stalled,
      congestion: congestion ?? this.congestion,
      congestionEnteredAt: congestionEnteredAt ?? this.congestionEnteredAt,
      tierPenalty: tierPenalty ?? this.tierPenalty,
    );
  }
}

/// 送信者ごとの直近の発話時刻（ADR-0024）。
class SpeakerActivity {
  const SpeakerActivity(this.senderId, this.lastSpeechAtMs);
  final int senderId;
  final int lastSpeechAtMs;
}

/// 受信者 1 人の遅延勾配。分子と分母の整数対で持つ。
class ReceiverTrend {
  const ReceiverTrend({
    required this.subscriberId,
    required this.numerator,
    required this.denominator,
  });
  final int subscriberId;
  final int numerator;
  final int denominator;
}

/// 送信者が申告した、または観測されたはしご。
class Ladder {
  const Ladder({
    required this.from,
    required this.ch,
    required this.rungs,
    required this.announced,
  });
  final int from;
  final int ch;
  /// sid の昇順。
  final List<LadderRung> rungs;
  /// 申告に由来するか。false は観測のみ（fps が分からない）。
  final bool announced;
}

/// 送信者 1 人に指令したエンコーダの上限段。
class EncoderTier {
  const EncoderTier({required this.targetId, required this.tier});
  final int targetId;
  final int tier;
}

class ShardState {
  ShardState({
    required this.participants,
    required this.subscriptions,
    required this.ladders,
    required this.trends,
    required this.speakers,
    required this.encoderTiers,
    required this.budgetBytesPerSec,
    required this.sentBytesInWindow,
    required this.sentMessagesInWindow,
    required this.windowStartMs,
    required this.overloadNotified,
    required this.received,
    required this.unexpectedEvents,
  });

  final List<int> participants;
  final List<Subscription> subscriptions;
  final List<Ladder> ladders;
  final List<ReceiverTrend> trends;
  final List<SpeakerActivity> speakers;
  final List<EncoderTier> encoderTiers;
  final int budgetBytesPerSec;
  final int sentBytesInWindow;
  final int sentMessagesInWindow;
  final int windowStartMs;
  final bool overloadNotified;
  final List<ReceivedMark> received;
  final List<String> unexpectedEvents;

  ShardState copyWith({
    List<int>? participants,
    List<Subscription>? subscriptions,
    List<Ladder>? ladders,
    List<ReceiverTrend>? trends,
    List<SpeakerActivity>? speakers,
    List<EncoderTier>? encoderTiers,
    int? budgetBytesPerSec,
    int? sentBytesInWindow,
    int? sentMessagesInWindow,
    int? windowStartMs,
    bool? overloadNotified,
    List<ReceivedMark>? received,
    List<String>? unexpectedEvents,
  }) {
    return ShardState(
      participants: participants ?? this.participants,
      subscriptions: subscriptions ?? this.subscriptions,
      ladders: ladders ?? this.ladders,
      trends: trends ?? this.trends,
      speakers: speakers ?? this.speakers,
      encoderTiers: encoderTiers ?? this.encoderTiers,
      budgetBytesPerSec: budgetBytesPerSec ?? this.budgetBytesPerSec,
      sentBytesInWindow: sentBytesInWindow ?? this.sentBytesInWindow,
      sentMessagesInWindow: sentMessagesInWindow ?? this.sentMessagesInWindow,
      windowStartMs: windowStartMs ?? this.windowStartMs,
      overloadNotified: overloadNotified ?? this.overloadNotified,
      received: received ?? this.received,
      unexpectedEvents: unexpectedEvents ?? this.unexpectedEvents,
    );
  }
}

/// 状態遷移の結果。
class StepResult {
  const StepResult({required this.state, required this.commands});
  final ShardState state;
  final List<ShardCommand> commands;
}

/// 初期状態。
ShardState initialState(int t) {
  return ShardState(
    participants: [],
    subscriptions: [],
    ladders: [],
    trends: [],
    speakers: [],
    encoderTiers: [],
    budgetBytesPerSec: constants.NODE_MAX_OUT_BYTES_PER_SEC,
    sentBytesInWindow: 0,
    sentMessagesInWindow: 0,
    windowStartMs: t,
    overloadNotified: false,
    received: [],
    unexpectedEvents: [],
  );
}

// ---------------------------------------------------------------------------
// ステップ関数
// ---------------------------------------------------------------------------

/// 1 ステップの状態遷移。
StepResult step(ShardState state, ShardEvent event, int t) {
  switch (event) {
    case MediaEvent():
      return _handleMedia(state, event, t);
    case SubscribeEvent():
      return _handleSubscribe(state, event, t);
    case AckEvent():
      return _handleAck(state, event, t);
    case StreamAnnounceEvent():
      return _handleStreamAnnounce(state, event, t);
    case JoinEvent():
      return _handleJoin(state, event);
    case LeaveEvent():
      return _handleLeave(state, event);
    case LinkEvent():
      return _ignoreEvent(state, 'link');
    case TimerEvent():
      return _handleTimer(state, t);
    case BudgetEvent():
      return _handleBudget(state, event, t);
    case ReportEvent():
      return _handleReport(state, event, t);
    case KeyframeRequestEvent():
      return _handleKeyframeRequest(state, event);
  }
}

/// 表に無いイベントの記録に 1 件加える。上限を超えたら古い側を捨てる（ADR-0034）。
List<String> _appendUnexpected(List<String> events, String name) {
  final List<String> appended = [...events, name];
  if (appended.length > constants.MAX_UNEXPECTED_EVENTS) {
    return appended.sublist(appended.length - constants.MAX_UNEXPECTED_EVENTS);
  }
  return appended;
}

StepResult _ignoreEvent(ShardState state, String name) {
  return StepResult(
    state: state.copyWith(
      unexpectedEvents: _appendUnexpected(state.unexpectedEvents, name),
    ),
    commands: [],
  );
}

/// 購読者のキーフレーム要求を送信者への要求へ直す（ADR-0039）。
/// 購読が無い相手への要求は無視して記録する。
StepResult _handleKeyframeRequest(ShardState state, KeyframeRequestEvent event) {
  final bool subscribed = state.subscriptions.any(
    (s) => s.subscriberId == event.from && s.targetId == event.target && s.channel == event.ch,
  );
  if (!subscribed) {
    return _ignoreEvent(state, 'keyframeRequest');
  }
  return StepResult(
    state: state,
    commands: [
      KeyframeRequestCommand(
        targetId: event.target,
        channel: event.ch,
        spatialId: event.sid,
      ),
    ],
  );
}

// ---------------------------------------------------------------------------
// メディア
// ---------------------------------------------------------------------------

bool _isAudioChannel(int ch) {
  return ch == wire_layout.CHANNEL_AUDIO || ch == wire_layout.CHANNEL_SCREEN_AUDIO;
}

StepResult _handleMedia(ShardState state, MediaEvent event, int t) {
  final windowed = _observeLadder(_maybeResetWindow(state, t), event);

  // 音声で ACTIVE_SPEAKER が立っていれば発話時刻を記録する。
  // 記録は選別の前に行う。今まさに発話している送信者の音声は通す必要がある。
  final bool audio = _isAudioChannel(event.ch);
  final bool speaking = (event.flags & wire_layout.FLAG_ACTIVE_SPEAKER) != 0;
  final ShardState withSpeech = audio && speaking
      ? windowed.copyWith(speakers: _recordSpeech(windowed.speakers, event.from, t))
      : windowed;

  final int? priority = dropPriority(event.ch, event.flags);
  // 受け取った位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
  final ShardState marked = _markReceived(withSpeech, event);

  final List<int> targets = [];
  final Map<int, int> dropped = {};
  final List<Subscription> nextSubscriptions = [];

  for (final sub in marked.subscriptions) {
    if (sub.targetId != event.from || sub.channel != event.ch) {
      nextSubscriptions.add(sub);
      continue;
    }
    final decision = _decideForSubscription(marked, sub, event, priority, t);
    nextSubscriptions.add(decision.subscription);
    if (decision.forward) {
      targets.add(sub.subscriberId);
      continue;
    }
    final int? dp = decision.dropPriority;
    if (dp != null) {
      final current = dropped[dp] ?? 0;
      dropped[dp] = current + 1;
    }
  }

  // 昇順に整列する（決定性のため）。
  targets.sort();

  final List<ShardCommand> commands = [];
  // 破棄は優先順位の昇順でまとめて 1 件ずつ報告する。
  final sortedKeys = dropped.keys.toList()..sort();
  for (final key in sortedKeys) {
    final int count = dropped[key] ?? 0;
    if (count > 0) {
      commands.add(DropCommand(priority: key, count: count));
    }
  }

  if (targets.isEmpty) {
    return StepResult(
      state: marked.copyWith(subscriptions: nextSubscriptions),
      commands: commands,
    );
  }

  commands.add(ForwardCommand(to: targets));

  // ノード全体の予算を計上する。転送の可否には使わない。
  final ShardState accounted = marked.copyWith(
    subscriptions: nextSubscriptions,
    sentMessagesInWindow: marked.sentMessagesInWindow + targets.length,
    sentBytesInWindow: marked.sentBytesInWindow + targets.length * event.bytes,
  );
  final overload = _notifyNodeOverload(accounted, t);
  return StepResult(
    state: overload.state,
    commands: [...commands, ...overload.commands],
  );
}

// ---------------------------------------------------------------------------
// 購読 1 本に対する転送の可否
// ---------------------------------------------------------------------------

class _SubscriptionDecision {
  const _SubscriptionDecision({
    required this.subscription,
    required this.forward,
    required this.dropPriority,
  });
  final Subscription subscription;
  final bool forward;
  final int? dropPriority;
}

/// 購読 1 本に対する転送判定。順序を固定する。
_SubscriptionDecision _decideForSubscription(
  ShardState state,
  Subscription sub,
  MediaEvent event,
  int? priority,
  int t,
) {
  // 1. ack が途絶えている → 渡さない
  if (sub.stalled) {
    return _SubscriptionDecision(subscription: sub, forward: false, dropPriority: null);
  }

  // 音声の選別転送（ADR-0024、ADR-0029 の 2）。
  // 本数は購読者ごとに決める。帯域が細い購読者へ全員分の音声を送ると映像の余地が無くなる。
  if (_isAudioChannel(event.ch) && !_isAudioForwarded(state, sub, event.from, t)) {
    // 輻輳による破棄ではないため priority は 0 とする（ADR-0024 の 5）。
    return _SubscriptionDecision(subscription: sub, forward: false, dropPriority: 0);
  }

  // 音声は段を持たない。段の選択は映像のみ。
  if (!_isAudioChannel(event.ch)) {
    final chosen = _chooseRung(state, sub);
    if (event.sid != chosen) {
      // 2. 段が合わない → 渡さない
      return _SubscriptionDecision(subscription: sub, forward: false, dropPriority: null);
    }
    if (event.tid > sub.maxTemporalId) {
      // 3. temporalId の超過 → 渡さない
      return _SubscriptionDecision(subscription: sub, forward: false, dropPriority: null);
    }
  }

  final bool mustForward = priority == null;

  // 4. 輻輳状態による破棄
  // mustForward が false なら priority は null ではない。ローカル変数で型を絞る。
  if (!mustForward) {
    final int p = priority;
    if (_shouldDropInCongestion(sub, event, p)) {
      return _SubscriptionDecision(subscription: sub, forward: false, dropPriority: p);
    }
    // 5. 送信窓が閉じている
    if (_isWindowClosed(state, sub, event)) {
      return _SubscriptionDecision(subscription: sub, forward: false, dropPriority: p);
    }
  }

  // 6. 渡す
  final int chosen = _isAudioChannel(event.ch) ? 0 : _chooseRung(state, sub);
  if (chosen != sub.windowSid) {
    // 渡す段が変わった。seq の空間が変わるため窓を作り直す。
    return _SubscriptionDecision(
      subscription: sub.copyWith(
        windowSid: chosen,
        highestSent: event.seq,
        highestAcked: event.seq - 1,
      ),
      forward: true,
      dropPriority: null,
    );
  }
  final int highestSent = event.seq > sub.highestSent ? event.seq : sub.highestSent;
  return _SubscriptionDecision(
    subscription: sub.copyWith(highestSent: highestSent),
    forward: true,
    dropPriority: null,
  );
}

/// 送信窓が閉じているか（congestion.md 2 節）。
/// 除算を避けて交差乗算で比較する。fps が不明なら窓を評価しない。
bool _isWindowClosed(ShardState state, Subscription sub, MediaEvent event) {
  final framerate = _framerateOf(state, sub);
  if (framerate <= 0) {
    return false;
  }
  // 窓がまだこの連番の空間に無いときは評価しない（ADR-0038）。
  final int chosen = _isAudioChannel(event.ch) ? 0 : _chooseRung(state, sub);
  if (chosen != sub.windowSid) {
    return false;
  }
  final inFlight = _inFlightFrames(sub, event.seq);
  return inFlight * 1000 > constants.SEND_WINDOW_MS * framerate;
}

/// 未確認のフレーム数。
int _inFlightFrames(Subscription sub, int seq) {
  final highest = seq > sub.highestSent ? seq : sub.highestSent;
  final inFlight = highest - sub.highestAcked - 1;
  return inFlight < 0 ? 0 : inFlight;
}

/// この購読が渡している段の fps。申告が無ければ 0。
int _framerateOf(ShardState state, Subscription sub) {
  final ladder = _findLadder(state, sub.targetId, sub.channel);
  if (ladder == null || !ladder.announced) {
    return 0;
  }
  final chosen = _chooseRung(state, sub);
  for (final rung in ladder.rungs) {
    if (rung.sid == chosen) {
      return rung.framerate;
    }
  }
  return 0;
}

/// この購読へ渡す段を 1 つ選ぶ（ADR-0027 の 3）。
int _chooseRung(ShardState state, Subscription sub) {
  final wanted = sub.maxSpatialId - sub.tierPenalty;
  final effective = wanted < 0 ? 0 : wanted;
  final ladder = _findLadder(state, sub.targetId, sub.channel);
  if (ladder == null || ladder.rungs.isEmpty) {
    // 段の情報が無い間は要求どおりの段だけを通す。
    return effective;
  }
  int best = -1;
  int lowest = -1;
  for (final rung in ladder.rungs) {
    if (lowest < 0 || rung.sid < lowest) {
      lowest = rung.sid;
    }
    if (rung.sid <= effective && rung.sid > best) {
      best = rung.sid;
    }
  }
  if (best >= 0) {
    return best;
  }
  return lowest < 0 ? effective : lowest;
}

/// 輻輳状態に応じた破棄判定。
bool _shouldDropInCongestion(Subscription sub, MediaEvent event, int priority) {
  switch (sub.congestion) {
    case Congestion.normal:
      return false;
    case Congestion.sheddingT2:
      return priority <= 3;
    case Congestion.sheddingT1:
      return event.tid >= 1;
    case Congestion.sheddingSpatial:
      // SHEDDING_SPATIAL では段を破棄しない。SHEDDING_T1 と同じ条件を維持する。
      return event.tid >= 1;
    case Congestion.keyOnly:
      return true;
  }
}

// ---------------------------------------------------------------------------
// 音声の選別転送（ADR-0024）
// ---------------------------------------------------------------------------

bool _isAudioForwarded(ShardState state, Subscription sub, int senderId, int t) {
  final limit = _audioLimitFor(sub);
  final List<SpeakerActivity> active = [];
  for (final entry in state.speakers) {
    if (t - entry.lastSpeechAtMs <= constants.AUDIO_SPEAKER_HOLD_MS) {
      active.add(entry);
    }
  }
  if (active.length <= limit) {
    // 上限に達していない。全員の音声を通す。DTX の無音で環境音が完全に消えると
    // 通話が不自然になるためである（ADR-0024 の 6）。
    return true;
  }
  active.sort((SpeakerActivity a, SpeakerActivity b) {
    if (a.lastSpeechAtMs != b.lastSpeechAtMs) {
      return b.lastSpeechAtMs - a.lastSpeechAtMs;
    }
    return a.senderId - b.senderId;
  });
  final chosen = active.take(limit).toList();
  return chosen.any((entry) => entry.senderId == senderId);
}

/// この購読者へ同時に転送する音声の本数（ADR-0029 の 2）。
/// 輻輳の段が深いほど減らす。1 本は必ず残す。
int _audioLimitFor(Subscription sub) {
  final reduced = constants.AUDIO_SELECTIVE_FORWARD_COUNT - _congestionDepth(sub.congestion);
  return reduced < constants.AUDIO_SELECTIVE_MIN_COUNT ? constants.AUDIO_SELECTIVE_MIN_COUNT : reduced;
}

/// 輻輳の深さ。NORMAL が 0 で、段が深くなるほど大きい。
int _congestionDepth(Congestion state) {
  switch (state) {
    case Congestion.normal:
      return 0;
    case Congestion.sheddingT2:
      return 1;
    case Congestion.sheddingT1:
      return 2;
    case Congestion.sheddingSpatial:
      return 3;
    case Congestion.keyOnly:
      return 4;
  }
}

List<SpeakerActivity> _recordSpeech(List<SpeakerActivity> speakers, int senderId, int t) {
  final List<SpeakerActivity> updated = [];
  bool replaced = false;
  for (final entry in speakers) {
    if (entry.senderId == senderId) {
      updated.add(SpeakerActivity(senderId, t));
      replaced = true;
      continue;
    }
    updated.add(entry);
  }
  if (!replaced) {
    updated.add(SpeakerActivity(senderId, t));
    updated.sort((SpeakerActivity a, SpeakerActivity b) => a.senderId - b.senderId);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// 購読
// ---------------------------------------------------------------------------

StepResult _handleSubscribe(ShardState state, SubscribeEvent event, int t) {
  final rest = state.subscriptions
      .where((s) => !(s.subscriberId == event.from && s.targetId == event.to && s.channel == event.ch))
      .toList();
  if (!event.want) {
    final sorted = rest..sort(_subscriptionOrder);
    return _withEncoderTiers(state.copyWith(subscriptions: sorted));
  }
  // 購読を張り直したときは送信窓と輻輳状態を初期化する。
  Subscription? existing;
  for (final s in state.subscriptions) {
    if (s.subscriberId == event.from && s.targetId == event.to && s.channel == event.ch) {
      existing = s;
      break;
    }
  }
  final created = Subscription(
    subscriberId: event.from,
    targetId: event.to,
    channel: event.ch,
    maxSpatialId: event.maxSpatialId,
    maxTemporalId: event.maxTemporalId,
    windowSid: existing?.windowSid ?? -1,
    highestSent: existing?.highestSent ?? 0,
    highestAcked: existing?.highestAcked ?? 0,
    lastAckAtMs: t,
    stalled: false,
    congestion: existing?.congestion ?? Congestion.normal,
    congestionEnteredAt: existing?.congestionEnteredAt ?? t,
    tierPenalty: existing?.tierPenalty ?? 0,
  );
  final subs = [...rest, created]..sort(_subscriptionOrder);
  return _withEncoderTiers(state.copyWith(subscriptions: subs));
}

/// 購読の和集合から送信者ごとの必要な上限段を求め、変化があれば setTier を出す。
StepResult _withEncoderTiers(ShardState state) {
  final List<int> targets = [];
  for (final sub in state.subscriptions) {
    if (!targets.contains(sub.targetId)) {
      targets.add(sub.targetId);
    }
  }
  targets.sort();

  final List<EncoderTier> nextTiers = [];
  final List<ShardCommand> commands = [];
  for (final targetId in targets) {
    int tier = 0;
    for (final sub in state.subscriptions) {
      if (sub.targetId == targetId && sub.maxSpatialId > tier) {
        tier = sub.maxSpatialId;
      }
    }
    nextTiers.add(EncoderTier(targetId: targetId, tier: tier));
    EncoderTier? previous;
    for (final entry in state.encoderTiers) {
      if (entry.targetId == targetId) {
        previous = entry;
        break;
      }
    }
    if (previous == null || previous.tier != tier) {
      commands.add(SetTierCommand(targetId: targetId, tier: tier));
    }
  }
  return StepResult(state: state.copyWith(encoderTiers: nextTiers), commands: commands);
}

int _subscriptionOrder(Subscription a, Subscription b) {
  if (a.subscriberId != b.subscriberId) {
    return a.subscriberId - b.subscriberId;
  }
  if (a.targetId != b.targetId) {
    return a.targetId - b.targetId;
  }
  return a.channel - b.channel;
}

// ---------------------------------------------------------------------------
// ack
// ---------------------------------------------------------------------------

StepResult _handleAck(ShardState state, AckEvent event, int t) {
  Subscription? target;
  for (final s in state.subscriptions) {
    if (s.subscriberId == event.from && s.targetId == event.to && s.channel == event.ch) {
      target = s;
      break;
    }
  }
  if (target == null) {
    return _ignoreEvent(state, 'ack');
  }
  if (event.sid != target.windowSid) {
    // 渡していない段への ack。段を変えた直後に古い ack が届くことがある。
    return _ignoreEvent(state, 'ack');
  }
  // 後戻りする ack は無視する。
  final highestAcked = event.highestSeq > target.highestAcked ? event.highestSeq : target.highestAcked;
  final updated = target.copyWith(highestAcked: highestAcked, lastAckAtMs: t, stalled: false);
  final subscriptions = state.subscriptions
      .where((s) => s != target)
      .toList()
    ..add(updated)
    ..sort(_subscriptionOrder);
  // ack で未確認量が減るため、輻輳状態を再評価する。
  return _evaluateAll(state.copyWith(subscriptions: subscriptions), t);
}

// ---------------------------------------------------------------------------
// streamAnnounce
// ---------------------------------------------------------------------------

StepResult _handleStreamAnnounce(ShardState state, StreamAnnounceEvent event, int t) {
  final rungs = [...event.rungs]..sort((a, b) => a.sid - b.sid);
  final rest = state.ladders.where((e) => !(e.from == event.from && e.ch == event.ch)).toList();
  final ladder = Ladder(from: event.from, ch: event.ch, rungs: rungs, announced: true);
  final ladders = [...rest, ladder]..sort(_ladderOrder);
  // はしごが変わると選ぶ段と fps が変わるため、輻輳状態を再評価する。
  return _evaluateAll(state.copyWith(ladders: ladders), t);
}

/// 観測からはしごを補う。申告が届く前でも段の集合が分かる。
ShardState _observeLadder(ShardState state, MediaEvent event) {
  if (_isAudioChannel(event.ch)) {
    return state;
  }
  final existing = _findLadder(state, event.from, event.ch);
  if (existing != null) {
    if (existing.announced) {
      return state;
    }
    bool found = false;
    for (final rung in existing.rungs) {
      if (rung.sid == event.sid) {
        found = true;
        break;
      }
    }
    if (found) {
      return state;
    }
    final rungs = [...existing.rungs, _observedRung(event.sid)]..sort((a, b) => a.sid - b.sid);
    final rest = state.ladders.where((e) => !(e.from == event.from && e.ch == event.ch)).toList();
    final updated = Ladder(from: existing.from, ch: existing.ch, rungs: rungs, announced: false);
    return state.copyWith(ladders: [...rest, updated]..sort(_ladderOrder));
  }
  final created = Ladder(from: event.from, ch: event.ch, rungs: [_observedRung(event.sid)], announced: false);
  return state.copyWith(ladders: [...state.ladders, created]..sort(_ladderOrder));
}

/// 観測のみで作る段。寸法と fps は不明。
LadderRung _observedRung(int sid) {
  return LadderRung(sid: sid, width: 0, height: 0, framerate: 0, temporalLayers: 0, targetBitrate: 0);
}

Ladder? _findLadder(ShardState state, int from, int ch) {
  for (final entry in state.ladders) {
    if (entry.from == from && entry.ch == ch) {
      return entry;
    }
  }
  return null;
}

int _ladderOrder(Ladder a, Ladder b) {
  return a.from != b.from ? a.from - b.from : a.ch - b.ch;
}

// ---------------------------------------------------------------------------
// 参加と退出
// ---------------------------------------------------------------------------

StepResult _handleJoin(ShardState state, JoinEvent event) {
  if (state.participants.contains(event.id)) {
    return StepResult(state: state, commands: []);
  }
  return StepResult(
    state: state.copyWith(participants: [...state.participants, event.id]..sort()),
    commands: [],
  );
}

StepResult _handleLeave(ShardState state, LeaveEvent event) {
  return _withEncoderTiers(state.copyWith(
    participants: state.participants.where((id) => id != event.id).toList(),
    subscriptions: state.subscriptions
        .where((s) => s.subscriberId != event.id && s.targetId != event.id)
        .toList(),
    trends: state.trends.where((tr) => tr.subscriberId != event.id).toList(),
    ladders: state.ladders.where((e) => e.from != event.id).toList(),
    speakers: state.speakers.where((e) => e.senderId != event.id).toList(),
    encoderTiers: state.encoderTiers.where((e) => e.targetId != event.id).toList(),
    received: state.received.where((m) => m.from != event.id).toList(),
  ));
}

// ---------------------------------------------------------------------------
// タイマー・予算・報告
// ---------------------------------------------------------------------------

StepResult _handleTimer(ShardState state, int t) {
  final windowed = _maybeResetWindow(state, t);
  final stalled = _detectAckTimeout(windowed, t);
  final evaluated = _evaluateAll(stalled.state, t);
  // 上流（送信ノード）へ受信位置を返す。返さないと送信ノードの窓が開かない。
  final List<ShardCommand> acks = evaluated.state.received
      .map((m) => AckUpstreamCommand(to: m.from, channel: m.ch, spatialId: m.sid, highestSeq: m.highestSeq))
      .toList();
  return StepResult(
    state: evaluated.state,
    commands: [...stalled.commands, ...evaluated.commands, ...acks],
  );
}

/// 受け取った位置を更新する。後戻りする値では更新しない。順序は from, ch, sid の昇順。
ShardState _markReceived(ShardState state, MediaEvent event) {
  if (event.seq <= 0) {
    return state;
  }
  for (final mark in state.received) {
    if (mark.from == event.from && mark.ch == event.ch && mark.sid == event.sid && mark.highestSeq >= event.seq) {
      return state;
    }
  }
  final List<ReceivedMark> next = state.received
      .where((m) => !(m.from == event.from && m.ch == event.ch && m.sid == event.sid))
      .toList()
    ..add(ReceivedMark(from: event.from, ch: event.ch, sid: event.sid, highestSeq: event.seq))
    ..sort((a, b) => a.from != b.from
        ? a.from - b.from
        : a.ch != b.ch
            ? a.ch - b.ch
            : a.sid - b.sid);
  return state.copyWith(received: next);
}

/// ack が途絶えた購読を検出する。未確認の媒体が無い購読は対象にしない。
StepResult _detectAckTimeout(ShardState state, int t) {
  final List<ShardCommand> commands = [];
  final List<Subscription> subscriptions = [];
  for (final sub in state.subscriptions) {
    final bool outstanding = sub.highestSent > sub.highestAcked;
    if (!sub.stalled && !outstanding) {
      // 未確認が無い間は時計を進める（ADR-0041）。
      // 「無通信」と「無応答」を区別するため、未確認の媒体が無い購読は
      // lastAckAtMs を現在時刻で更新する。
      subscriptions.add(sub.copyWith(lastAckAtMs: t));
      continue;
    }
    if (sub.stalled || t - sub.lastAckAtMs < constants.ACK_TIMEOUT_MS) {
      subscriptions.add(sub);
      continue;
    }
    subscriptions.add(sub.copyWith(stalled: true));
    commands.add(DisconnectCommand(peer: sub.subscriberId));
  }
  return StepResult(state: state.copyWith(subscriptions: subscriptions), commands: commands);
}

StepResult _handleBudget(ShardState state, BudgetEvent event, int t) {
  return _evaluateAll(state.copyWith(budgetBytesPerSec: event.bytesPerSec), t);
}

StepResult _handleReport(ShardState state, ReportEvent event, int t) {
  final Slope slope = delaySlope(event.delayUs);
  final rest = state.trends.where((tr) => tr.subscriberId != event.from).toList();
  final updated = ReceiverTrend(
    subscriberId: event.from,
    numerator: slope.numerator,
    denominator: slope.denominator,
  );
  final trends = [...rest, updated]..sort((a, b) => a.subscriberId - b.subscriberId);
  return _evaluateAll(state.copyWith(trends: trends), t);
}

// ---------------------------------------------------------------------------
// 輻輳状態の遷移（購読単位）
// ---------------------------------------------------------------------------

/// すべての購読の輻輳状態を評価する。購読ごとに独立に評価する。
StepResult _evaluateAll(ShardState state, int t) {
  final List<ShardCommand> commands = [];
  final List<Subscription> subscriptions = [];
  for (final sub in state.subscriptions) {
    final result = _evaluateSubscription(state, sub, t);
    subscriptions.add(result.subscription);
    commands.addAll(result.commands);
  }
  return StepResult(state: state.copyWith(subscriptions: subscriptions), commands: commands);
}

class _EvaluateResult {
  const _EvaluateResult({required this.subscription, required this.commands});
  final Subscription subscription;
  final List<ShardCommand> commands;
}

_EvaluateResult _evaluateSubscription(ShardState state, Subscription sub, int t) {
  // ヒステリシス: 振動を防ぐ。
  if (t - sub.congestionEnteredAt < constants.SHEDDING_HYSTERESIS_MS) {
    return _EvaluateResult(subscription: sub, commands: []);
  }

  Congestion next = sub.congestion;
  switch (sub.congestion) {
    case Congestion.normal:
      if (_fillGreater(state, sub, constants.SHARD_UTIL_ENTER_T2_NUM, constants.SHARD_UTIL_ENTER_T2_DEN) ||
          _trendGreater(state, sub, constants.SHARD_TREND_ENTER_T2_NUM, constants.SHARD_TREND_ENTER_T2_DEN)) {
        next = Congestion.sheddingT2;
      }
    case Congestion.sheddingT2:
      if (_fillGreater(state, sub, constants.SHARD_UTIL_ENTER_T1_NUM, constants.SHARD_UTIL_ENTER_T1_DEN) ||
          _trendGreater(state, sub, constants.SHARD_TREND_ENTER_T1_NUM, constants.SHARD_TREND_ENTER_T1_DEN)) {
        next = Congestion.sheddingT1;
      } else if (_fillLess(state, sub, constants.SHARD_UTIL_EXIT_T2_NUM, constants.SHARD_UTIL_EXIT_T2_DEN) &&
          _trendLess(state, sub, constants.SHARD_TREND_EXIT_NUM, constants.SHARD_TREND_EXIT_DEN)) {
        next = Congestion.normal;
      }
    case Congestion.sheddingT1:
      if (_fillGreater(state, sub, constants.SHARD_UTIL_ENTER_SPATIAL_NUM, constants.SHARD_UTIL_ENTER_SPATIAL_DEN) ||
          _trendGreater(state, sub, constants.SHARD_TREND_ENTER_SPATIAL_NUM, constants.SHARD_TREND_ENTER_SPATIAL_DEN)) {
        next = Congestion.sheddingSpatial;
      } else if (_fillLess(state, sub, constants.SHARD_UTIL_EXIT_T1_NUM, constants.SHARD_UTIL_EXIT_T1_DEN) &&
          _trendLess(state, sub, constants.SHARD_TREND_EXIT_NUM, constants.SHARD_TREND_EXIT_DEN)) {
        next = Congestion.sheddingT2;
      }
    case Congestion.sheddingSpatial:
      if (_fillGreater(state, sub, constants.SHARD_UTIL_ENTER_KEY_ONLY_NUM, constants.SHARD_UTIL_ENTER_KEY_ONLY_DEN) ||
          _trendGreater(state, sub, constants.SHARD_TREND_ENTER_KEY_ONLY_NUM, constants.SHARD_TREND_ENTER_KEY_ONLY_DEN)) {
        next = Congestion.keyOnly;
      } else if (_fillLess(state, sub, constants.SHARD_UTIL_EXIT_SPATIAL_NUM, constants.SHARD_UTIL_EXIT_SPATIAL_DEN) &&
          _trendLess(state, sub, constants.SHARD_TREND_EXIT_NUM, constants.SHARD_TREND_EXIT_DEN)) {
        next = Congestion.sheddingT1;
      }
    case Congestion.keyOnly:
      if (_fillLess(state, sub, constants.SHARD_UTIL_EXIT_KEY_ONLY_NUM, constants.SHARD_UTIL_EXIT_KEY_ONLY_DEN) &&
          _trendLess(state, sub, constants.SHARD_TREND_EXIT_KEY_ONLY_NUM, constants.SHARD_TREND_EXIT_KEY_ONLY_DEN)) {
        next = Congestion.sheddingSpatial;
      }
  }

  if (next == sub.congestion) {
    return _EvaluateResult(subscription: sub, commands: []);
  }

  // SHEDDING_SPATIAL 以降は段を 1 つ下げる。
  final int penalty = (next == Congestion.sheddingSpatial || next == Congestion.keyOnly) ? 1 : 0;
  final updated = sub.copyWith(
    congestion: next,
    congestionEnteredAt: t,
    tierPenalty: penalty,
  );
  final List<ShardCommand> commands = [];
  if (penalty != sub.tierPenalty) {
    // 購読者へ setTier を送ってはならない（ADR-0033）。段の変化は媒体の spatialId で伝わる。
    commands.add(KeyframeRequestCommand(
      targetId: sub.targetId,
      channel: sub.channel,
      spatialId: _chooseRung(state, updated),
    ));
  }
  return _EvaluateResult(subscription: updated, commands: commands);
}

// ---------------------------------------------------------------------------
// 充填率と勾配の判定
// ---------------------------------------------------------------------------

/// 送信窓の充填率が閾値を超えているか。
/// fps が不明なら fill を 0 とみなす。勾配のみで判定する。
bool _fillGreater(ShardState state, Subscription sub, int num, int den) {
  final framerate = _framerateOf(state, sub);
  if (framerate <= 0) {
    return false;
  }
  final inFlight = _inFlightFrames(sub, sub.highestSent);
  return inFlight * 1000 * den > num * constants.SEND_WINDOW_MS * framerate;
}

bool _fillLess(ShardState state, Subscription sub, int num, int den) {
  final framerate = _framerateOf(state, sub);
  if (framerate <= 0) {
    // 充填率を評価できない。回復を妨げないため、条件を満たすとみなす。
    return num > 0;
  }
  final inFlight = _inFlightFrames(sub, sub.highestSent);
  return inFlight * 1000 * den < num * constants.SEND_WINDOW_MS * framerate;
}

/// この購読者の遅延勾配が閾値を超えているか。他の購読者の勾配は見ない。
bool _trendGreater(ShardState state, Subscription sub, int num, int den) {
  ReceiverTrend? trend;
  for (final entry in state.trends) {
    if (entry.subscriberId == sub.subscriberId) {
      trend = entry;
      break;
    }
  }
  if (trend == null) {
    return false;
  }
  return trend.numerator * den > num * trend.denominator;
}

/// 報告が無い場合は回復条件を満たすとみなす。
bool _trendLess(ShardState state, Subscription sub, int num, int den) {
  ReceiverTrend? trend;
  for (final entry in state.trends) {
    if (entry.subscriberId == sub.subscriberId) {
      trend = entry;
      break;
    }
  }
  if (trend == null) {
    return true;
  }
  return trend.numerator * den < num * trend.denominator;
}

// ---------------------------------------------------------------------------
// ノード全体の予算
// ---------------------------------------------------------------------------

/// 予算超過を制御系へ通知する。転送の可否には使わない。
StepResult _notifyNodeOverload(ShardState state, int t) {
  if (state.overloadNotified) {
    return StepResult(state: state, commands: []);
  }
  final elapsed = t - state.windowStartMs;
  if (elapsed <= 0) {
    return StepResult(state: state, commands: []);
  }
  final bool messagesOver =
      state.sentMessagesInWindow * 1000 > constants.NODE_MAX_OUT_MESSAGES_PER_SEC * elapsed;
  final bool bytesOver =
      state.sentBytesInWindow * 1000 > state.budgetBytesPerSec * elapsed;
  if (!messagesOver && !bytesOver) {
    return StepResult(state: state, commands: []);
  }
  return StepResult(
    state: state.copyWith(overloadNotified: true),
    commands: [NotifyCommand(code: errors.E_NODE_OVERLOADED_CLOSE_CODE)],
  );
}

ShardState _maybeResetWindow(ShardState state, int t) {
  final elapsed = t - state.windowStartMs;
  if (elapsed >= constants.SHARD_UTIL_WINDOW_MS) {
    return state.copyWith(
      sentBytesInWindow: 0,
      sentMessagesInWindow: 0,
      windowStartMs: t,
      overloadNotified: false,
    );
  }
  return state;
}
