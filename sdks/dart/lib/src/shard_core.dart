// 中継ノード（shard）の判断コア（Dart）。
//
// TypeScript の参照実装（packages/core/src/shard-core.ts）と**同じ入力列から同じ出力列**を
// 返さなければならない（conformance.md 2 節の層 2）。検証は凍結トレースベクタで行う。
//
// sans-IO。時刻は入力として受け取り、内部で取得しない。
// 浮動小数点を使わない。例外を投げない。

import 'fixed.dart' show delaySlope, Slope;
import 'generated/constants.dart' as constants;
import 'generated/errors.dart' as errors;
import 'wire.dart' show dropPriority;

/// 輻輳状態（state-machines.md 3 節）。
enum Congestion {
  normal,
  sheddingT2,
  sheddingT1,
  sheddingSpatial,
  keyOnly,
}

/// 状態の名前。トレースの照合用に使う。
String congestionName(Congestion value) {
  switch (value) {
    case Congestion.normal:
      return 'NORMAL';
    case Congestion.sheddingT2:
      return 'SHEDDING_T2';
    case Congestion.sheddingT1:
      return 'SHEDDING_T1';
    case Congestion.sheddingSpatial:
      return 'SHEDDING_SPATIAL';
    case Congestion.keyOnly:
      return 'KEY_ONLY';
  }
}

/// 購読 1 件の情報。
class Subscription {
  const Subscription({
    required this.subscriberId,
    required this.targetId,
    required this.maxSpatialId,
  });
  final int subscriberId;
  final int targetId;
  final int maxSpatialId;
}

/// 受信者ごとの遅延勾配。
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

/// 送信者ごとの観測した最大 spatialId。
class MaxSpatial {
  const MaxSpatial({required this.from, required this.ch, required this.sid});
  final int from;
  final int ch;
  final int sid;
}

/// 送信者 1 人に指令したエンコーダの上限層。
class EncoderTier {
  const EncoderTier({required this.targetId, required this.tier});
  final int targetId;
  final int tier;
}

/// shard の状態。
class ShardState {
  ShardState({
    required this.congestion,
    required this.congestionEnteredAt,
    required this.participants,
    required this.subscriptions,
    required this.budgetBytesPerSec,
    required this.sentBytesInWindow,
    required this.sentMessagesInWindow,
    required this.windowStartMs,
    required this.unexpectedEvents,
    required this.trends,
    required this.maxSpatial,
    required this.encoderTiers,
  });

  final Congestion congestion;
  final int congestionEnteredAt;
  final List<int> participants;
  final List<Subscription> subscriptions;
  final int budgetBytesPerSec;
  final int sentBytesInWindow;
  final int sentMessagesInWindow;
  final int windowStartMs;
  final List<String> unexpectedEvents;
  final List<ReceiverTrend> trends;
  final List<MaxSpatial> maxSpatial;
  final List<EncoderTier> encoderTiers;

  /// コピーを作る。変更は新しいインスタンスとして返す（sans-IO の純関数）。
  ShardState copyWith({
    Congestion? congestion,
    int? congestionEnteredAt,
    List<int>? participants,
    List<Subscription>? subscriptions,
    int? budgetBytesPerSec,
    int? sentBytesInWindow,
    int? sentMessagesInWindow,
    int? windowStartMs,
    List<String>? unexpectedEvents,
    List<ReceiverTrend>? trends,
    List<MaxSpatial>? maxSpatial,
    List<EncoderTier>? encoderTiers,
  }) {
    return ShardState(
      congestion: congestion ?? this.congestion,
      congestionEnteredAt: congestionEnteredAt ?? this.congestionEnteredAt,
      participants: participants ?? List.of(this.participants),
      subscriptions: subscriptions ?? List.of(this.subscriptions),
      budgetBytesPerSec: budgetBytesPerSec ?? this.budgetBytesPerSec,
      sentBytesInWindow: sentBytesInWindow ?? this.sentBytesInWindow,
      sentMessagesInWindow: sentMessagesInWindow ?? this.sentMessagesInWindow,
      windowStartMs: windowStartMs ?? this.windowStartMs,
      unexpectedEvents: unexpectedEvents ?? List.of(this.unexpectedEvents),
      trends: trends ?? List.of(this.trends),
      maxSpatial: maxSpatial ?? List.of(this.maxSpatial),
      encoderTiers: encoderTiers ?? List.of(this.encoderTiers),
    );
  }
}

/// 入力イベント。sealed で閉じる（判定漏れを防ぐ）。
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
  });
  final int from;
  final int ch;
  final int sid;
  final int tid;
  final bool key;
  final int bytes;
  final int flags;
}

class SubscribeEvent implements ShardEvent {
  const SubscribeEvent({
    required this.from,
    required this.to,
    required this.want,
    required this.maxSpatialId,
  });
  final int from;
  final int to;
  final bool want;
  final int maxSpatialId;
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

/// 出力コマンド。sealed で閉じる。
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

class NotifyCommand implements ShardCommand {
  const NotifyCommand({required this.code});
  final int code;
}

/// 送信者のエンコーダの上限層を変える（ADR-0022）。
class SetTierCommand implements ShardCommand {
  const SetTierCommand({required this.targetId, required this.tier});
  final int targetId;
  final int tier;
}

/// 状態遷移の結果。
class StepResult {
  const StepResult({required this.state, required this.commands});
  final ShardState state;
  final List<ShardCommand> commands;
}

/// 初期状態。トレースの最初の時刻を渡す。
ShardState initialState(int t) {
  return ShardState(
    congestion: Congestion.normal,
    congestionEnteredAt: t,
    participants: [],
    subscriptions: [],
    budgetBytesPerSec: constants.NODE_MAX_OUT_BYTES_PER_SEC,
    sentBytesInWindow: 0,
    sentMessagesInWindow: 0,
    windowStartMs: t,
    unexpectedEvents: [],
    trends: [],
    maxSpatial: [],
    encoderTiers: [],
  );
}

/// 過負荷を通知するクローズコード。生成物から参照する（数値をコードに書かない）。
const int _nodeOverloadedCloseCode = errors.E_NODE_OVERLOADED_CLOSE_CODE;

/// 1 ステップの状態遷移。
StepResult step(ShardState state, ShardEvent event, int t) {
  switch (event) {
    case MediaEvent():
      return _handleMedia(state, event, t);
    case SubscribeEvent():
      return _handleSubscribe(state, event.from, event.to, event.want, event.maxSpatialId);
    case JoinEvent():
      return _handleJoin(state, event.id);
    case LeaveEvent():
      return _handleLeave(state, event.id);
    case LinkEvent():
      // 表に無いイベントは無視して記録する。
      final next = state.copyWith(
        unexpectedEvents: [...state.unexpectedEvents, 'link'],
      );
      return StepResult(state: next, commands: []);
    case TimerEvent():
      final reset = _maybeResetWindow(state, t);
      return _evaluateCongestion(reset, t);
    case BudgetEvent():
      final next = state.copyWith(budgetBytesPerSec: event.bytesPerSec);
      return _evaluateCongestion(next, t);
    case ReportEvent():
      return _handleReport(state, event.from, event.delayUs, t);
  }
}

StepResult _handleMedia(ShardState state, MediaEvent unit, int t) {
  final resetState = _maybeResetWindow(state, t);
  final next = _updateMaxSpatial(resetState, unit.from, unit.ch, unit.sid);
  final priority = dropPriority(unit.ch, unit.flags);

  if (_shouldDropInCongestion(next, unit.sid, unit.tid, unit.from, unit.ch, priority)) {
    return StepResult(
      state: next,
      commands: [DropCommand(priority: priority ?? 0, count: 1)],
    );
  }

  final targets = <int>[];
  for (final sub in next.subscriptions) {
    if (sub.targetId == unit.from && unit.sid <= sub.maxSpatialId) {
      targets.add(sub.subscriberId);
    }
  }
  targets.sort();

  if (targets.isEmpty) {
    return StepResult(state: next, commands: []);
  }

  final msgCost = targets.length;
  final byteCost = msgCost * unit.bytes;
  final updatedMessages = next.sentMessagesInWindow + msgCost;
  final updatedBytes = next.sentBytesInWindow + byteCost;

  if (_isOverBudget(updatedMessages, updatedBytes, next, t)) {
    if (priority != null) {
      return StepResult(
        state: next,
        commands: [DropCommand(priority: priority, count: 1)],
      );
    }
  }

  final commands = <ShardCommand>[ForwardCommand(to: targets)];
  final afterForward = next.copyWith(
    sentBytesInWindow: next.sentBytesInWindow + byteCost,
    sentMessagesInWindow: next.sentMessagesInWindow + msgCost,
  );
  final evaluated = _evaluateCongestion(afterForward, t);
  commands.addAll(evaluated.commands);
  return StepResult(state: evaluated.state, commands: commands);
}

StepResult _handleSubscribe(
    ShardState state, int from, int to, bool want, int maxSpatialId) {
  final subs = state.subscriptions
      .where((sub) => !(sub.subscriberId == from && sub.targetId == to))
      .toList();
  if (want) {
    subs.add(Subscription(subscriberId: from, targetId: to, maxSpatialId: maxSpatialId));
    subs.sort((a, b) {
      final cmp = a.subscriberId.compareTo(b.subscriberId);
      if (cmp != 0) return cmp;
      return a.targetId.compareTo(b.targetId);
    });
  }
  final next = state.copyWith(subscriptions: subs);
  return _withEncoderTiers(next);
}

/// 購読の和集合から送信者ごとの必要な上限層を求め、変化した送信者へ SetTier を出す。
StepResult _withEncoderTiers(ShardState state) {
  final targets = <int>[];
  for (final sub in state.subscriptions) {
    if (!targets.contains(sub.targetId)) {
      targets.add(sub.targetId);
    }
  }
  targets.sort();

  final nextTiers = <EncoderTier>[];
  final commands = <ShardCommand>[];
  for (final targetId in targets) {
    var tier = 0;
    for (final sub in state.subscriptions) {
      if (sub.targetId == targetId && sub.maxSpatialId > tier) {
        tier = sub.maxSpatialId;
      }
    }
    nextTiers.add(EncoderTier(targetId: targetId, tier: tier));
    final previous = _findEncoderTier(state.encoderTiers, targetId);
    if (previous == null || previous.tier != tier) {
      commands.add(SetTierCommand(targetId: targetId, tier: tier));
    }
  }
  final next = state.copyWith(encoderTiers: nextTiers);
  return StepResult(state: next, commands: commands);
}

EncoderTier? _findEncoderTier(List<EncoderTier> tiers, int targetId) {
  for (final entry in tiers) {
    if (entry.targetId == targetId) {
      return entry;
    }
  }
  return null;
}

StepResult _handleJoin(ShardState state, int id) {
  if (state.participants.contains(id)) {
    return StepResult(state: state.copyWith(), commands: []);
  }
  final participants = [...state.participants, id];
  participants.sort();
  return StepResult(state: state.copyWith(participants: participants), commands: []);
}

StepResult _handleLeave(ShardState state, int id) {
  final participants = state.participants.where((v) => v != id).toList();
  final subs = state.subscriptions
      .where((sub) => sub.subscriberId != id && sub.targetId != id)
      .toList();
  // 退出者の遅延勾配と観測した spatialId も除去する。
  // 残すと、居なくなった相手の古い観測が輻輳の判定に影響し続ける。
  final trends = state.trends.where((t) => t.subscriberId != id).toList();
  final maxSp = state.maxSpatial.where((e) => e.from != id).toList();
  // 退出者への指令の記録も除去する。残すと再参加時に指令が出ない。
  final encoderTiers = state.encoderTiers.where((e) => e.targetId != id).toList();
  final next = state.copyWith(
    participants: participants,
    subscriptions: subs,
    trends: trends,
    maxSpatial: maxSp,
    encoderTiers: encoderTiers,
  );
  return _withEncoderTiers(next);
}

StepResult _handleReport(ShardState state, int from, List<int> delayUs, int t) {
  final slope = delaySlope(delayUs);
  final trends = state.trends.where((tr) => tr.subscriberId != from).toList();
  trends.add(ReceiverTrend(
    subscriberId: from,
    numerator: slope.numerator,
    denominator: slope.denominator,
  ));
  trends.sort((a, b) => a.subscriberId.compareTo(b.subscriberId));
  final next = state.copyWith(trends: trends);
  return _evaluateCongestion(next, t);
}

ShardState _maybeResetWindow(ShardState state, int t) {
  if (t - state.windowStartMs >= constants.SHARD_UTIL_WINDOW_MS) {
    return state.copyWith(
      sentBytesInWindow: 0,
      sentMessagesInWindow: 0,
      windowStartMs: t,
    );
  }
  return state.copyWith();
}

ShardState _updateMaxSpatial(ShardState state, int from, int ch, int sid) {
  for (final entry in state.maxSpatial) {
    if (entry.from == from && entry.ch == ch) {
      if (entry.sid >= sid) {
        return state.copyWith();
      }
      break;
    }
  }
  final updated = state.maxSpatial
      .where((e) => !(e.from == from && e.ch == ch))
      .toList();
  updated.add(MaxSpatial(from: from, ch: ch, sid: sid));
  updated.sort((a, b) {
    final cmp = a.from.compareTo(b.from);
    if (cmp != 0) return cmp;
    return a.ch.compareTo(b.ch);
  });
  return state.copyWith(maxSpatial: updated);
}

int _maxSpatialFor(ShardState state, int from, int ch) {
  for (final entry in state.maxSpatial) {
    if (entry.from == from && entry.ch == ch) {
      return entry.sid;
    }
  }
  return 0;
}

bool _shouldDropInCongestion(
    ShardState state, int sid, int tid, int from, int ch, int? priority) {
  if (priority == null) {
    return false;
  }
  switch (state.congestion) {
    case Congestion.normal:
      return false;
    case Congestion.sheddingT2:
      return priority <= 3;
    case Congestion.sheddingT1:
      return tid >= 1;
    case Congestion.sheddingSpatial:
      return sid >= _maxSpatialFor(state, from, ch) || tid >= 1;
    case Congestion.keyOnly:
      return true;
  }
}

bool _isOverBudget(int projectedMessages, int projectedBytes, ShardState state, int t) {
  final window = t - state.windowStartMs;
  if (window <= 0) {
    return false;
  }
  final messageOver =
      projectedMessages * 1000 > constants.NODE_MAX_OUT_MESSAGES_PER_SEC * window;
  final byteOver = projectedBytes * 1000 > state.budgetBytesPerSec * window;
  return messageOver || byteOver;
}

bool _utilGreater(ShardState state, int t, int num, int den) {
  final window = t - state.windowStartMs;
  if (window <= 0) {
    return false;
  }
  return state.sentMessagesInWindow * 1000 * den >
      num * window * constants.NODE_MAX_OUT_MESSAGES_PER_SEC;
}

bool _utilLess(ShardState state, int t, int num, int den) {
  final window = t - state.windowStartMs;
  if (window <= 0) {
    return num > 0;
  }
  return state.sentMessagesInWindow * 1000 * den <
      num * window * constants.NODE_MAX_OUT_MESSAGES_PER_SEC;
}

bool _trendGreater(ShardState state, int num, int den) {
  for (final trend in state.trends) {
    if (trend.numerator * den > num * trend.denominator) {
      return true;
    }
  }
  return false;
}

bool _trendLess(ShardState state, int num, int den) {
  for (final trend in state.trends) {
    if (!(trend.numerator * den < num * trend.denominator)) {
      return false;
    }
  }
  return true;
}

StepResult _evaluateCongestion(ShardState state, int t) {
  if (t - state.congestionEnteredAt < constants.SHEDDING_HYSTERESIS_MS) {
    return StepResult(state: state, commands: []);
  }
  final Congestion nextPhase;
  switch (state.congestion) {
    case Congestion.normal:
      if (_utilGreater(state, t, constants.SHARD_UTIL_ENTER_T2_NUM, constants.SHARD_UTIL_ENTER_T2_DEN) ||
          _trendGreater(state, constants.SHARD_TREND_ENTER_T2_NUM, constants.SHARD_TREND_ENTER_T2_DEN)) {
        nextPhase = Congestion.sheddingT2;
      } else {
        nextPhase = Congestion.normal;
      }
    case Congestion.sheddingT2:
      if (_utilGreater(state, t, constants.SHARD_UTIL_ENTER_T1_NUM, constants.SHARD_UTIL_ENTER_T1_DEN) ||
          _trendGreater(state, constants.SHARD_TREND_ENTER_T1_NUM, constants.SHARD_TREND_ENTER_T1_DEN)) {
        nextPhase = Congestion.sheddingT1;
      } else if (_utilLess(state, t, constants.SHARD_UTIL_EXIT_T2_NUM, constants.SHARD_UTIL_EXIT_T2_DEN) &&
          _trendLess(state, constants.SHARD_TREND_EXIT_NUM, constants.SHARD_TREND_EXIT_DEN)) {
        nextPhase = Congestion.normal;
      } else {
        nextPhase = Congestion.sheddingT2;
      }
    case Congestion.sheddingT1:
      if (_utilGreater(state, t, constants.SHARD_UTIL_ENTER_SPATIAL_NUM, constants.SHARD_UTIL_ENTER_SPATIAL_DEN) ||
          _trendGreater(state, constants.SHARD_TREND_ENTER_SPATIAL_NUM, constants.SHARD_TREND_ENTER_SPATIAL_DEN)) {
        nextPhase = Congestion.sheddingSpatial;
      } else if (_utilLess(state, t, constants.SHARD_UTIL_EXIT_T1_NUM, constants.SHARD_UTIL_EXIT_T1_DEN) &&
          _trendLess(state, constants.SHARD_TREND_EXIT_NUM, constants.SHARD_TREND_EXIT_DEN)) {
        nextPhase = Congestion.sheddingT2;
      } else {
        nextPhase = Congestion.sheddingT1;
      }
    case Congestion.sheddingSpatial:
      if (_utilGreater(state, t, constants.SHARD_UTIL_ENTER_KEY_ONLY_NUM, constants.SHARD_UTIL_ENTER_KEY_ONLY_DEN) ||
          _trendGreater(state, constants.SHARD_TREND_ENTER_KEY_ONLY_NUM, constants.SHARD_TREND_ENTER_KEY_ONLY_DEN)) {
        nextPhase = Congestion.keyOnly;
      } else if (_utilLess(state, t, constants.SHARD_UTIL_EXIT_SPATIAL_NUM, constants.SHARD_UTIL_EXIT_SPATIAL_DEN) &&
          _trendLess(state, constants.SHARD_TREND_EXIT_NUM, constants.SHARD_TREND_EXIT_DEN)) {
        nextPhase = Congestion.sheddingT1;
      } else {
        nextPhase = Congestion.sheddingSpatial;
      }
    case Congestion.keyOnly:
      if (_utilLess(state, t, constants.SHARD_UTIL_EXIT_KEY_ONLY_NUM, constants.SHARD_UTIL_EXIT_KEY_ONLY_DEN) &&
          _trendLess(state, constants.SHARD_TREND_EXIT_KEY_ONLY_NUM, constants.SHARD_TREND_EXIT_KEY_ONLY_DEN)) {
        nextPhase = Congestion.sheddingSpatial;
      } else {
        nextPhase = Congestion.keyOnly;
      }
  }

  if (nextPhase == state.congestion) {
    return StepResult(state: state, commands: []);
  }
  final commands = <ShardCommand>[];
  if (nextPhase == Congestion.keyOnly) {
    commands.add(NotifyCommand(code: _nodeOverloadedCloseCode));
  }
  final next = state.copyWith(
    congestion: nextPhase,
    congestionEnteredAt: t,
  );
  return StepResult(state: next, commands: commands);
}
