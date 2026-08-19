// 受信ノード（receiver）の判断コア（Dart）。
//
// TypeScript の参照実装（packages/core/src/receiver-core.ts）と**同一の出力**を
// 返さなければならない。照合は凍結トレース（spec/vectors/trace-receiver.jsonl）で行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻・乱数・浮動小数点・入出力に触れない。除算は整数の切り捨てのみを使う。

import 'fixed.dart' show delaySlope, truncDiv, Slope;
import 'generated/constants.dart' as constants;
import 'generated/wire_layout.dart' as wire_layout;

/// 品質低下の警告。文言は利用側が国際化キーから作る（sdk-api.md 6 節）。
const String _degradedWarning = 'W_DEGRADED';

/// 受信者自身の識別子。転送先は常にこの 1 人である。
const int receiverSelfId = 0;

// ---------------------------------------------------------------------------
// 購読状態（state-machines.md 2 節）
// ---------------------------------------------------------------------------

/// AUDIO_ONLY は ADR-0029 で追加した。映像の購読を落として音声だけを維持する状態である。
enum StreamPhase { unsubscribed, subscribed, paused, audioOnly }

// ---------------------------------------------------------------------------
// カタログ（ADR-0027）
// ---------------------------------------------------------------------------

/// カタログの 1 段。streamCatalog から取り込む。
class CatalogRung {
  const CatalogRung({
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

/// 送信者 1 人・1 チャネルのはしご。
class CatalogLadder {
  const CatalogLadder({
    required this.senderId,
    required this.channel,
    required this.rungs,
  });
  final int senderId;
  final int channel;
  /// sid の昇順で保持する。
  final List<CatalogRung> rungs;
}

// ---------------------------------------------------------------------------
// ストリーム状態
// ---------------------------------------------------------------------------

class StreamState {
  const StreamState({
    required this.senderId,
    required this.channel,
    required this.phase,
    required this.spatialId,
    required this.temporalId,
    required this.displayWidth,
  });
  final int senderId;
  final int channel;
  final StreamPhase phase;
  final int spatialId;
  final int temporalId;
  /// 利用側が申告した表示寸法（論理画素）。未申告は 0。
  final int displayWidth;

  StreamState copyWith({StreamPhase? phase, int? spatialId, int? displayWidth}) {
    return StreamState(
      senderId: senderId,
      channel: channel,
      phase: phase ?? this.phase,
      spatialId: spatialId ?? this.spatialId,
      temporalId: temporalId,
      displayWidth: displayWidth ?? this.displayWidth,
    );
  }
}

/// 受信済みの位置。ack の内容になる。
class ReceivedMark {
  const ReceivedMark({
    required this.senderId,
    required this.channel,
    required this.spatialId,
    required this.highestSeq,
  });
  final int senderId;
  final int channel;
  final int spatialId;
  final int highestSeq;
}

// ---------------------------------------------------------------------------
// 受信者の状態
// ---------------------------------------------------------------------------

class ReceiverState {
  const ReceiverState({
    required this.streams,
    required this.catalog,
    required this.visible,
    required this.targetBytesPerSec,
    required this.activeSpeakerId,
    required this.trend,
    required this.degraded,
    required this.audioOnly,
    required this.rateHoldUntilMs,
    required this.recoverStreak,
    required this.targetCeilingBytesPerSec,
    required this.unexpectedEvents,
    required this.received,
  });

  final List<StreamState> streams;
  final List<CatalogLadder> catalog;
  final bool visible;
  final int targetBytesPerSec;
  final int? activeSpeakerId;
  final Slope trend;
  final bool degraded;
  final bool audioOnly;
  final int rateHoldUntilMs;
  final int recoverStreak;
  final int targetCeilingBytesPerSec;
  final List<String> unexpectedEvents;
  final List<ReceivedMark> received;

  ReceiverState copyWith({
    List<StreamState>? streams,
    List<CatalogLadder>? catalog,
    bool? visible,
    int? targetBytesPerSec,
    int? activeSpeakerId,
    bool clearActiveSpeaker = false,
    Slope? trend,
    bool? degraded,
    bool? audioOnly,
    int? rateHoldUntilMs,
    int? recoverStreak,
    int? targetCeilingBytesPerSec,
    List<String>? unexpectedEvents,
    List<ReceivedMark>? received,
  }) {
    return ReceiverState(
      streams: streams ?? List.of(this.streams),
      catalog: catalog ?? this.catalog,
      visible: visible ?? this.visible,
      targetBytesPerSec: targetBytesPerSec ?? this.targetBytesPerSec,
      activeSpeakerId: clearActiveSpeaker ? null : (activeSpeakerId ?? this.activeSpeakerId),
      trend: trend ?? this.trend,
      degraded: degraded ?? this.degraded,
      audioOnly: audioOnly ?? this.audioOnly,
      rateHoldUntilMs: rateHoldUntilMs ?? this.rateHoldUntilMs,
      recoverStreak: recoverStreak ?? this.recoverStreak,
      targetCeilingBytesPerSec: targetCeilingBytesPerSec ?? this.targetCeilingBytesPerSec,
      unexpectedEvents: unexpectedEvents ?? List.of(this.unexpectedEvents),
      received: received ?? List.of(this.received),
    );
  }
}

// ---------------------------------------------------------------------------
// 入力イベント
// ---------------------------------------------------------------------------

class SubscribeEntry {
  const SubscribeEntry({
    required this.senderId,
    required this.channel,
    required this.maxSpatialId,
    required this.maxTemporalId,
  });
  final int senderId;
  final int channel;
  final int maxSpatialId;
  final int maxTemporalId;
}

sealed class ReceiverEvent {}

class SubscribeListEvent implements ReceiverEvent {
  const SubscribeListEvent({required this.entries});
  final List<SubscribeEntry> entries;
}

class LeaveEvent implements ReceiverEvent {
  const LeaveEvent({required this.id});
  final int id;
}

class VisibilityEvent implements ReceiverEvent {
  const VisibilityEvent({required this.visible});
  final bool visible;
}

/// 観測した goodput。**目標を下げない**（congestion.md 4.1）。
class GoodputEvent implements ReceiverEvent {
  const GoodputEvent({required this.bytesPerSec});
  final int bytesPerSec;
}

class BudgetEvent implements ReceiverEvent {
  const BudgetEvent({required this.bytesPerSec});
  final int bytesPerSec;
}

class ActiveSpeakerEvent implements ReceiverEvent {
  const ActiveSpeakerEvent({required this.id});
  final int? id;
}

class CatalogEvent implements ReceiverEvent {
  const CatalogEvent({required this.entries});
  final List<CatalogLadder> entries;
}

class DisplaySizeEvent implements ReceiverEvent {
  const DisplaySizeEvent({required this.senderId, required this.channel, required this.width});
  final int senderId;
  final int channel;
  final int width;
}

class ReportEvent implements ReceiverEvent {
  const ReportEvent({required this.delayUs});
  final List<int> delayUs;
}

class MediaEvent implements ReceiverEvent {
  const MediaEvent({
    required this.from,
    required this.ch,
    required this.sid,
    required this.tid,
    required this.seq,
  });
  final int from;
  final int ch;
  final int sid;
  final int tid;
  final int seq;
}

/// 購読者からのキーフレーム要求（ADR-0039）。
/// 要求をそのまま keyframeRequest コマンドに直す。状態は変えない。
class KeyframeRequestEvent implements ReceiverEvent {
  const KeyframeRequestEvent({
    required this.senderId,
    required this.channel,
    required this.spatialId,
  });
  final int senderId;
  final int channel;
  final int spatialId;
}

class TimerEvent implements ReceiverEvent {
  const TimerEvent();
}

// ---------------------------------------------------------------------------
// 出力コマンド
// ---------------------------------------------------------------------------

sealed class ReceiverCommand {}

class SubscribeChangeCommand implements ReceiverCommand {
  const SubscribeChangeCommand({
    required this.to,
    required this.channel,
    required this.want,
    required this.maxSpatialId,
    required this.maxTemporalId,
  });
  final int to;
  final int channel;
  final bool want;
  final int maxSpatialId;
  final int maxTemporalId;
}

class KeyframeRequestCommand implements ReceiverCommand {
  const KeyframeRequestCommand({
    required this.targetId,
    required this.channel,
    required this.spatialId,
  });
  final int targetId;
  final int channel;
  final int spatialId;
}

class SetTierCommand implements ReceiverCommand {
  const SetTierCommand({required this.targetId, required this.channel, required this.tier});
  final int targetId;
  final int channel;
  final int tier;
}

class ForwardCommand implements ReceiverCommand {
  const ForwardCommand({required this.to});
  final List<int> to;
}

class DropCommand implements ReceiverCommand {
  const DropCommand({required this.priority, required this.count});
  final int priority;
  final int count;
}

class NotifyCommand implements ReceiverCommand {
  const NotifyCommand({required this.code});
  final String code;
}

class AckCommand implements ReceiverCommand {
  const AckCommand({
    required this.senderId,
    required this.channel,
    required this.spatialId,
    required this.highestSeq,
  });
  final int senderId;
  final int channel;
  final int spatialId;
  final int highestSeq;
}

class ReceiverStepResult {
  const ReceiverStepResult({required this.state, required this.commands});
  final ReceiverState state;
  final List<ReceiverCommand> commands;
}

// ---------------------------------------------------------------------------
// 初期状態と状態遷移
// ---------------------------------------------------------------------------

/// 初期状態。引数を取らない。目標は最低から始める。
ReceiverState initialReceiverState() {
  final floorResult = truncDiv(constants.MIN_VIABLE_BPS, 8);
  final int floor = floorResult.isOk ? (floorResult.value ?? 0) : 0;
  return ReceiverState(
    streams: <StreamState>[],
    catalog: <CatalogLadder>[],
    visible: true,
    targetBytesPerSec: floor,
    activeSpeakerId: null,
    trend: const Slope(0, 1),
    degraded: false,
    audioOnly: false,
    rateHoldUntilMs: 0,
    recoverStreak: 0,
    targetCeilingBytesPerSec: floor,
    unexpectedEvents: <String>[],
    received: <ReceivedMark>[],
  );
}

/// 純関数の状態遷移。時刻は AIMD の待ち（RATE_HOLD_MS）に使う。
ReceiverStepResult receiverStep(ReceiverState state, ReceiverEvent event, [int t = 0]) {
  switch (event) {
    case SubscribeListEvent():
      return _handleSubscribe(state, event.entries);
    case LeaveEvent():
      return _handleLeave(state, event.id);
    case VisibilityEvent():
      return _handleVisibility(state, event.visible);
    case BudgetEvent():
      return _handleBudget(state, event.bytesPerSec);
    case GoodputEvent():
      return _handleGoodput(state, event.bytesPerSec);
    case ActiveSpeakerEvent():
      final id = event.id;
      return _reallocate(
        id == null ? state.copyWith(clearActiveSpeaker: true) : state.copyWith(activeSpeakerId: id),
      );
    case CatalogEvent():
      return _handleCatalog(state, event.entries);
    case DisplaySizeEvent():
      return _handleDisplaySize(state, event.senderId, event.channel, event.width);
    case ReportEvent():
      return _handleReport(state, event.delayUs, t);
    case MediaEvent():
      return _handleMedia(state, event);
    case KeyframeRequestEvent():
      // 判断は無い。要求をコマンドへ直すだけである（間隔制限は実行側）。
      return ReceiverStepResult(
        state: state,
        commands: <ReceiverCommand>[
          KeyframeRequestCommand(
            targetId: event.senderId,
            channel: event.channel,
            spatialId: event.spatialId,
          ),
        ],
      );
    case TimerEvent():
      return ReceiverStepResult(
        state: state,
        commands: state.received
            .map((mark) => AckCommand(
                  senderId: mark.senderId,
                  channel: mark.channel,
                  spatialId: mark.spatialId,
                  highestSeq: mark.highestSeq,
                ))
            .toList(),
      );
  }
}

// ---------------------------------------------------------------------------
// 帯域とカタログ
// ---------------------------------------------------------------------------

/// goodput の観測。天井を押し上げるだけに使う（congestion.md 4.1）。
/// 観測した goodput。天井を押し上げ、目標を上げる方向にだけ使う（congestion.md 4.1）。
ReceiverStepResult _handleGoodput(ReceiverState state, int bytesPerSec) {
  if (bytesPerSec <= 0) {
    return ReceiverStepResult(state: state, commands: const []);
  }
  final int ceiling =
      bytesPerSec > state.targetCeilingBytesPerSec ? bytesPerSec : state.targetCeilingBytesPerSec;
  // 規範 4.1: available = max(goodput, 現在の目標レート)。**天井で切らない。**
  // 中継ノードは目標の分しか転送しないため、天井で切ると目標は最低成立点から
  // 一生上がらない（実測の記録は `_desiredCostBytesPerSec` の注記にある）。
  final int target = bytesPerSec > state.targetBytesPerSec ? bytesPerSec : state.targetBytesPerSec;
  if (target == state.targetBytesPerSec && ceiling == state.targetCeilingBytesPerSec) {
    return ReceiverStepResult(state: state, commands: const []);
  }
  return _reallocate(state.copyWith(targetBytesPerSec: target, targetCeilingBytesPerSec: ceiling));
}

ReceiverStepResult _handleBudget(ReceiverState state, int bytesPerSec) {
  final ceiling = bytesPerSec > state.targetCeilingBytesPerSec
      ? bytesPerSec
      : state.targetCeilingBytesPerSec;
  return _reallocate(state.copyWith(
    targetBytesPerSec: bytesPerSec,
    targetCeilingBytesPerSec: ceiling,
  ));
}

ReceiverStepResult _handleCatalog(ReceiverState state, List<CatalogLadder> entries) {
  final normalized = entries
      .map((entry) => CatalogLadder(
            senderId: entry.senderId,
            channel: entry.channel,
            rungs: List.of(entry.rungs)..sort((a, b) => a.sid - b.sid),
          ))
      .toList()
    ..sort((a, b) => a.senderId != b.senderId
        ? a.senderId - b.senderId
        : a.channel - b.channel);
  // はしごが変わると段の上限と費用が変わるため、配分を作り直す。
  return _reallocate(state.copyWith(catalog: normalized));
}

List<CatalogRung> _ladderOf(ReceiverState state, int senderId, int channel) {
  for (final entry in state.catalog) {
    if (entry.senderId == senderId && entry.channel == channel) {
      return entry.rungs;
    }
  }
  return const <CatalogRung>[];
}

/// 表示寸法から要求すべき段の上限を返す。表示幅以上の幅を持つ最小の段。
int _rungCapFor(ReceiverState state, StreamState stream) {
  final rungs = _ladderOf(state, stream.senderId, stream.channel);
  if (rungs.isEmpty) {
    return 0;
  }
  CatalogRung? lowest;
  CatalogRung? top;
  for (final rung in rungs) {
    if (lowest == null || rung.sid < lowest.sid) {
      lowest = rung;
    }
    if (top == null || rung.sid > top.sid) {
      top = rung;
    }
  }
  if (lowest == null || top == null) {
    return 0;
  }
  if (stream.displayWidth <= 0) {
    return lowest.sid;
  }
  CatalogRung? best;
  for (final rung in rungs) {
    if (rung.width < stream.displayWidth) {
      continue;
    }
    if (best == null || rung.width < best.width) {
      best = rung;
    }
  }
  return best == null ? top.sid : best.sid;
}

/// 望む品質の申告ビットレートの合計（bytes/sec）。
///
/// AIMD の加算的増加の上限として使う。goodput の観測最大値を上限にすると
/// 「目標 ≤ goodput ≤ 目標」の輪が閉じ、目標は最低成立点から一生上がらない。
/// 実測（2026-07-30、実環境・劣化なし）: 目標が 30,620 bytes/s（MIN_VIABLE_BPS/8）に
/// 張り付き、中継ノードが基底層 417 件を含む 842 件を捨てた。送信は 1,342 件、
/// 到着は 577 件だった。
int _desiredCostBytesPerSec(ReceiverState state) {
  int bits = 0;
  for (final stream in state.streams) {
    if (stream.phase != StreamPhase.subscribed) {
      continue;
    }
    if (_isAudio(stream.channel)) {
      bits += _costOf(state, stream, stream.spatialId);
      continue;
    }
    bits += _costOf(state, stream, _rungCapFor(state, stream));
  }
  final bytes = truncDiv(bits, 8);
  return bytes.isOk ? (bytes.value ?? 0) : 0;
}

/// 段の費用（bits/sec）。申告が無ければ 0。
int _costOf(ReceiverState state, StreamState stream, int sid) {
  for (final rung in _ladderOf(state, stream.senderId, stream.channel)) {
    if (rung.sid == sid) {
      return rung.targetBitrate;
    }
  }
  return 0;
}

/// はしごの最下段。カタログが無ければ 0。
int _lowestRung(ReceiverState state, StreamState stream) {
  final rungs = _ladderOf(state, stream.senderId, stream.channel);
  int lowest = -1;
  for (final rung in rungs) {
    if (lowest < 0 || rung.sid < lowest) {
      lowest = rung.sid;
    }
  }
  return lowest < 0 ? 0 : lowest;
}

/// はしごの最上段。カタログが無ければ 0。
int _highestRung(ReceiverState state, StreamState stream) {
  final rungs = _ladderOf(state, stream.senderId, stream.channel);
  int top = -1;
  for (final rung in rungs) {
    if (rung.sid > top) {
      top = rung.sid;
    }
  }
  return top < 0 ? 0 : top;
}

bool _isAudio(int channel) {
  return channel == wire_layout.CHANNEL_AUDIO || channel == wire_layout.CHANNEL_SCREEN_AUDIO;
}

// ---------------------------------------------------------------------------
// 購読
// ---------------------------------------------------------------------------

/// 購読一覧の適用。
ReceiverStepResult _handleSubscribe(ReceiverState state, List<SubscribeEntry> entries) {
  final commands = <ReceiverCommand>[];
  final kept = <StreamState>[];

  final sorted = List.of(entries)..sort(_compareEntries);
  for (final entry in sorted) {
    final existing = _findStream(state, entry.senderId, entry.channel);
    if (existing == null || existing.phase == StreamPhase.unsubscribed) {
      // 新規購読は最下段から始める。細い回線で初手に最上段を要求すると詰まる。
      final start = _isAudio(entry.channel)
          ? 0
          : _lowestRung(state, StreamState(
              senderId: entry.senderId,
              channel: entry.channel,
              phase: StreamPhase.subscribed,
              spatialId: 0,
              temporalId: 0,
              displayWidth: 0,
            ));
      commands.add(SubscribeChangeCommand(
        to: entry.senderId,
        channel: entry.channel,
        want: true,
        maxSpatialId: start,
        maxTemporalId: entry.maxTemporalId,
      ));
      commands.add(KeyframeRequestCommand(
        targetId: entry.senderId,
        channel: entry.channel,
        spatialId: start,
      ));
      kept.add(StreamState(
        senderId: entry.senderId,
        channel: entry.channel,
        phase: StreamPhase.subscribed,
        spatialId: start,
        temporalId: entry.maxTemporalId,
        displayWidth: existing?.displayWidth ?? 0,
      ));
      continue;
    }
    kept.add(existing.copyWith(phase: StreamPhase.subscribed));
  }

  // 一覧から外れたものは購読解除する。
  for (final stream in state.streams) {
    var stillWanted = false;
    for (final entry in entries) {
      if (entry.senderId == stream.senderId && entry.channel == stream.channel) {
        stillWanted = true;
        break;
      }
    }
    if (!stillWanted && stream.phase != StreamPhase.unsubscribed) {
      commands.add(SubscribeChangeCommand(
        to: stream.senderId,
        channel: stream.channel,
        want: false,
        maxSpatialId: 0,
        maxTemporalId: 0,
      ));
    }
  }

  kept.sort(_compareStreams);
  final after = _reallocate(state.copyWith(streams: kept));
  return ReceiverStepResult(
    state: after.state,
    commands: <ReceiverCommand>[...commands, ...after.commands],
  );
}

/// 送信者の退出。退出者のカタログも除去する。
ReceiverStepResult _handleLeave(ReceiverState state, int id) {
  final streams = state.streams.where((stream) => stream.senderId != id).toList();
  if (streams.length == state.streams.length) {
    return ReceiverStepResult(state: state, commands: <ReceiverCommand>[]);
  }
  final received = state.received.where((mark) => mark.senderId != id).toList();
  final catalog = state.catalog.where((entry) => entry.senderId != id).toList();
  return _reallocate(state.copyWith(streams: streams, received: received, catalog: catalog));
}

/// 表示・非表示。
ReceiverStepResult _handleVisibility(ReceiverState state, bool visible) {
  if (visible == state.visible) {
    return ReceiverStepResult(state: state, commands: <ReceiverCommand>[]);
  }
  final commands = <ReceiverCommand>[];
  final streams = <StreamState>[];
  for (final stream in state.streams) {
    if (!visible && stream.phase == StreamPhase.subscribed) {
      commands.add(SubscribeChangeCommand(
        to: stream.senderId,
        channel: stream.channel,
        want: false,
        maxSpatialId: 0,
        maxTemporalId: 0,
      ));
      streams.add(stream.copyWith(phase: StreamPhase.paused));
      continue;
    }
    if (visible && stream.phase == StreamPhase.paused) {
      commands.add(SubscribeChangeCommand(
        to: stream.senderId,
        channel: stream.channel,
        want: true,
        maxSpatialId: stream.spatialId,
        maxTemporalId: stream.temporalId,
      ));
      commands.add(KeyframeRequestCommand(
        targetId: stream.senderId,
        channel: stream.channel,
        spatialId: stream.spatialId,
      ));
      streams.add(stream.copyWith(phase: StreamPhase.subscribed));
      continue;
    }
    streams.add(stream);
  }
  return ReceiverStepResult(
    state: state.copyWith(visible: visible, streams: streams),
    commands: commands,
  );
}

/// 表示寸法の申告。
ReceiverStepResult _handleDisplaySize(ReceiverState state, int senderId, int channel, int width) {
  if (_findStream(state, senderId, channel) == null) {
    // 表に無いイベントの記録は上限を超えたら古い側を捨てる（ADR-0034）。
    final appended = List.of(state.unexpectedEvents)..add('displaySize');
    final unexpected = appended.length > constants.MAX_UNEXPECTED_EVENTS
        ? appended.sublist(appended.length - constants.MAX_UNEXPECTED_EVENTS)
        : appended;
    return ReceiverStepResult(
      state: state.copyWith(unexpectedEvents: unexpected),
      commands: <ReceiverCommand>[],
    );
  }
  final streams = state.streams
      .map((stream) => stream.senderId == senderId && stream.channel == channel
          ? stream.copyWith(displayWidth: width)
          : stream)
      .toList();
  return _reallocate(state.copyWith(streams: streams));
}

// ---------------------------------------------------------------------------
// 報告と AIMD
// ---------------------------------------------------------------------------

/// 遅延の報告に対する応答。tier と target の両方を更新する。
ReceiverStepResult _handleReport(ReceiverState state, List<int> delayUs, int t) {
  // 標本が 2 個未満では勾配が定まらない。定まらない値で AIMD を動かしてはならない。
  if (delayUs.length < 2) {
    return ReceiverStepResult(state: state, commands: const []);
  }
  final trend = delaySlope(delayUs);
  final degrading = trend.numerator * constants.SHARD_TREND_ENTER_T2_DEN >
      constants.SHARD_TREND_ENTER_T2_NUM * trend.denominator;
  final recovering = trend.numerator * constants.SHARD_TREND_EXIT_DEN <
      constants.SHARD_TREND_EXIT_NUM * trend.denominator;

  int target = state.targetBytesPerSec;
  int holdUntil = state.rateHoldUntilMs;
  int streak = state.recoverStreak;

  if (degrading) {
    streak = 0;
    if (t >= state.rateHoldUntilMs) {
      final reduced = truncDiv(target * 17, 20);
      final reducedValue = reduced.value;
      final int lowered = (reduced.isOk && reducedValue != null) ? reducedValue : target;
      // 予兆で最低成立点を割らない（ADR-0040）
      final floorResult = truncDiv(constants.MIN_VIABLE_BPS, 8);
      final floorValue = floorResult.value;
      final int floor = (floorResult.isOk && floorValue != null) ? floorValue : 0;
      target = lowered < floor ? floor : lowered;
      holdUntil = t + constants.RATE_HOLD_MS;
    }
  } else if (recovering) {
    streak = state.recoverStreak + 1;
    if (streak >= constants.RATE_RECOVER_STREAK) {
      final increment = truncDiv(constants.RATE_PROBE_BPS, 8);
      final incrementValue = increment.value;
      final raised = target + (increment.isOk && incrementValue != null ? incrementValue : 0);
      // 上限は望む品質の申告ビットレートである（規範 4.2）。観測した goodput を
      // 上限にすると輪が閉じて目標が上がらない（`_desiredCostBytesPerSec` の注記）。
      // 申告がまだ無い（カタログ未着）間は上限を作らない。知らないことは制約ではない。
      final declared = _desiredCostBytesPerSec(state);
      // 上限が最低成立点を下回ってはならない（ADR-0040）。最下段の申告（200 kbps）は
      // MIN_VIABLE_BPS（音声を含む 244,960）より小さい。申告だけで切ると目標が
      // 最低成立点の下へ押し戻され、AUDIO_ONLY の出入りを往復する（実測で振動した）。
      final floorForCap = truncDiv(constants.MIN_VIABLE_BPS, 8);
      final floorForCapValue = floorForCap.value;
      final int minimum = (floorForCap.isOk && floorForCapValue != null) ? floorForCapValue : 0;
      final int cap = (declared > 0 && declared < minimum) ? minimum : declared;
      target = cap > 0 && raised > cap ? cap : raised;
      streak = 0;
    }
  } else {
    streak = 0;
  }

  final afterRate = state.copyWith(
    trend: trend,
    targetBytesPerSec: target,
    rateHoldUntilMs: holdUntil,
    recoverStreak: streak,
  );

  if (!degrading && !recovering) {
    return ReceiverStepResult(state: afterRate, commands: <ReceiverCommand>[]);
  }

  // tier を 1 段動かす。
  final delta = degrading ? -1 : 1;
  final commands = <ReceiverCommand>[];
  final streams = <StreamState>[];
  for (final stream in afterRate.streams) {
    if (stream.phase != StreamPhase.subscribed || _isAudio(stream.channel)) {
      // 音声には段が無い。輻輳でも音声の段を動かしてはならない。
      streams.add(stream);
      continue;
    }
    final floor = _lowestRung(afterRate, stream);
    final cap = _rungCapFor(afterRate, stream);
    final raw = stream.spatialId + delta;
    final nextSpatial = raw < floor ? floor : (raw > cap ? cap : raw);
    if (nextSpatial == stream.spatialId) {
      streams.add(stream);
      continue;
    }
    streams.add(stream.copyWith(spatialId: nextSpatial));
    commands.add(SetTierCommand(targetId: stream.senderId, channel: stream.channel, tier: nextSpatial));
    // 段が変わるとキーフレームが必要である（simulcast では上下とも）。
    commands.add(KeyframeRequestCommand(
      targetId: stream.senderId,
      channel: stream.channel,
      spatialId: nextSpatial,
    ));
  }
  final stepped = afterRate.copyWith(streams: streams);
  if (target == state.targetBytesPerSec) {
    return ReceiverStepResult(state: stepped, commands: commands);
  }
  // 音声だけの状態の出入りだけをやり直す（規範 4.3、ADR-0029）。
  //
  // 配分の全部をやり直してはならない。reallocate は「買える最良の段」を選ぶため、
  // 予算が潤沢な回線では遅延勾配による降格を直後に打ち消す（実測: 降格の試験で
  // 段が 2 から 1 へ下がらなくなった）。音声だけの出入りは reallocate にしか無い。
  // 報告の経路で呼ばなければ、回復の勾配がいくら続いても映像が戻らない（実測:
  // 目標が 29,620 → 154,620 bytes/s まで回復しても audioOnly が true のまま）。
  if (!_crossesAudioOnly(stepped)) {
    return ReceiverStepResult(state: stepped, commands: commands);
  }
  final reallocated = _reallocate(stepped);
  return ReceiverStepResult(
    state: reallocated.state,
    commands: <ReceiverCommand>[...commands, ...reallocated.commands],
  );
}

/// いまの目標が音声だけの状態の境界を跨いでいるか（ADR-0029 のヒステリシス）。
///
/// 跨いでいる場合だけ配分をやり直す。判定は reallocate と同じ式でなければならないため、
/// 回線の速度（目標 × 8）で見る。予算（9/10）で見ると余裕を二重に引くことになる。
bool _crossesAudioOnly(ReceiverState state) {
  final linkBps = state.targetBytesPerSec * 8;
  final bool wanted = state.audioOnly
      ? linkBps < constants.AUDIO_ONLY_EXIT_BPS
      : linkBps < constants.AUDIO_ONLY_ENTER_BPS;
  return wanted != state.audioOnly;
}

/// メディアの転送。要求 tier を超えるユニットは転送しない。
ReceiverStepResult _handleMedia(ReceiverState state, MediaEvent event) {
  final stream = _findStream(state, event.from, event.ch);
  if (stream == null || stream.phase != StreamPhase.subscribed) {
    // 音声は購読が未確立でも転送する（音声は破棄禁止）。
    // 音声と映像は別の部屋を通り、購読の確立も別である。音声の購読が遅れて確立する間に
    // 届いた音声がここで消えるのを防ぐ。映像は落として正しい（購読していない送信者の
    // 映像を復号器へ渡すと参照が壊れる）。音声は段を持たず参照連鎖の制約が無い。
    // ack 位置も記録する。ack 位置が記録されれば中継の送信窓が進み、stalled になりにくい。
    if (_isAudio(event.ch)) {
      return ReceiverStepResult(
        state: _markReceived(state, event),
        commands: <ReceiverCommand>[const ForwardCommand(to: <int>[receiverSelfId])],
      );
    }
    return ReceiverStepResult(state: state, commands: <ReceiverCommand>[]);
  }
  if (event.sid > stream.spatialId || event.tid > stream.temporalId) {
    return ReceiverStepResult(
      state: state,
      commands: <ReceiverCommand>[const DropCommand(priority: 1, count: 1)],
    );
  }
  return ReceiverStepResult(
    state: _markReceived(state, event),
    commands: <ReceiverCommand>[const ForwardCommand(to: <int>[receiverSelfId])],
  );
}

// ---------------------------------------------------------------------------
// 段の配分（congestion.md 4.3、ADR-0027、ADR-0029）
// ---------------------------------------------------------------------------

/// 帯域予算から段を配分する。
ReceiverStepResult _reallocate(ReceiverState state) {
  final commands = <ReceiverCommand>[];
  // 回線の速度（bits/sec）。
  final linkBps = state.targetBytesPerSec * 8;
  // 段を買うための予算。10% をヘッダと制御に取る。
  final budgetResult = truncDiv(linkBps * 9, 10);
  final budgetBps = budgetResult.isOk ? (budgetResult.value ?? 0) : 0;

  // 音声だけの状態への出入り（ヒステリシス。ADR-0029）。
  // 判定は回線の速度そのもので行う。予算で判定すると余裕を二重に引くことになる。
  final bool audioOnly = state.audioOnly
      ? linkBps < constants.AUDIO_ONLY_EXIT_BPS
      : linkBps < constants.AUDIO_ONLY_ENTER_BPS;

  if (audioOnly) {
    final streams = <StreamState>[];
    for (final stream in state.streams) {
      if (_isAudio(stream.channel)) {
        streams.add(stream);
        continue;
      }
      if (stream.phase == StreamPhase.subscribed) {
        commands.add(SubscribeChangeCommand(
          to: stream.senderId,
          channel: stream.channel,
          want: false,
          maxSpatialId: 0,
          maxTemporalId: 0,
        ));
        streams.add(stream.copyWith(phase: StreamPhase.audioOnly));
        continue;
      }
      streams.add(stream);
    }
    if (!state.degraded) {
      commands.add(const NotifyCommand(code: _degradedWarning));
    }
    streams.sort(_compareStreams);
    return ReceiverStepResult(
      state: state.copyWith(streams: streams, audioOnly: true, degraded: true),
      commands: commands,
    );
  }

  // 映像へ戻す（AUDIO_ONLY から復帰する）。
  final revived = <StreamState>[];
  for (final stream in state.streams) {
    if (stream.phase == StreamPhase.audioOnly) {
      final floor = _lowestRung(state, stream);
      revived.add(stream.copyWith(phase: StreamPhase.subscribed, spatialId: floor));
      commands.add(SubscribeChangeCommand(
        to: stream.senderId,
        channel: stream.channel,
        want: true,
        maxSpatialId: floor,
        maxTemporalId: stream.temporalId,
      ));
      commands.add(KeyframeRequestCommand(
        targetId: stream.senderId,
        channel: stream.channel,
        spatialId: floor,
      ));
      continue;
    }
    revived.add(stream);
  }
  final base = state.copyWith(streams: revived, audioOnly: false);

  // 予算で段を買う。
  final ordered = base.streams
      .where((stream) => stream.phase == StreamPhase.subscribed)
      .toList()
    ..sort((a, b) => _priorityOrder(base, a, b));

  final assigned = <String, int>{};
  int remaining = budgetBps;
  bool degraded = false;

  for (final stream in ordered) {
    if (_isAudio(stream.channel)) {
      // 音声は段を持たない。費用は予算から引くが段の選択は行わない。
      remaining -= _costOf(base, stream, 0);
      continue;
    }
    final floor = _lowestRung(base, stream);
    final cap = _rungCapFor(base, stream);
    int chosen = floor;
    // 上限から下へ降りて、予算に収まる最も高い段を選ぶ。
    for (int sid = cap; sid >= floor; sid -= 1) {
      final cost = _costOf(base, stream, sid);
      if (cost <= remaining) {
        chosen = sid;
        break;
      }
    }
    final chosenCost = _costOf(base, stream, chosen);
    if (chosenCost > remaining) {
      // 最下段さえ入らない。最低保証として最下段を維持し警告する。
      degraded = true;
    }
    remaining -= chosenCost;
    assigned[_streamKey(stream)] = chosen;
  }

  final streams = <StreamState>[];
  for (final stream in base.streams) {
    final next = assigned[_streamKey(stream)];
    if (next == null || next == stream.spatialId) {
      streams.add(stream);
      continue;
    }
    commands.add(SetTierCommand(targetId: stream.senderId, channel: stream.channel, tier: next));
    commands.add(KeyframeRequestCommand(
      targetId: stream.senderId,
      channel: stream.channel,
      spatialId: next,
    ));
    streams.add(stream.copyWith(spatialId: next));
  }

  if (degraded && !base.degraded) {
    commands.add(const NotifyCommand(code: _degradedWarning));
  }

  streams.sort(_compareStreams);
  return ReceiverStepResult(
    state: base.copyWith(streams: streams, degraded: degraded),
    commands: commands,
  );
}

// ---------------------------------------------------------------------------
// 補助関数
// ---------------------------------------------------------------------------

/// 発話者を先に、音声を最優先。順序は決定的でなければならない。
int _priorityOrder(ReceiverState state, StreamState a, StreamState b) {
  // 音声を先に配分する（ADR-0029 の 4）。
  final aAudio = _isAudio(a.channel) ? 0 : 1;
  final bAudio = _isAudio(b.channel) ? 0 : 1;
  if (aAudio != bAudio) {
    return aAudio - bAudio;
  }
  final aSpeaker = state.activeSpeakerId == a.senderId ? 0 : 1;
  final bSpeaker = state.activeSpeakerId == b.senderId ? 0 : 1;
  if (aSpeaker != bSpeaker) {
    return aSpeaker - bSpeaker;
  }
  if (a.senderId != b.senderId) {
    return a.senderId - b.senderId;
  }
  return a.channel - b.channel;
}

String _streamKey(StreamState stream) {
  return '${stream.senderId}:${stream.channel}';
}

/// 受信した位置を更新する。後戻りする値では更新しない。
ReceiverState _markReceived(ReceiverState state, MediaEvent event) {
  final seq = event.seq;
  if (seq <= 0) {
    return state;
  }
  for (final mark in state.received) {
    if (mark.senderId == event.from && mark.channel == event.ch && mark.spatialId == event.sid) {
      if (mark.highestSeq >= seq) {
        return state;
      }
      break;
    }
  }
  final merged = state.received
      .where((mark) =>
          !(mark.senderId == event.from && mark.channel == event.ch && mark.spatialId == event.sid))
      .toList()
    ..add(ReceivedMark(
      senderId: event.from,
      channel: event.ch,
      spatialId: event.sid,
      highestSeq: seq,
    ))
    ..sort((a, b) {
      if (a.senderId != b.senderId) {
        return a.senderId - b.senderId;
      }
      if (a.channel != b.channel) {
        return a.channel - b.channel;
      }
      return a.spatialId - b.spatialId;
    });
  return state.copyWith(received: merged);
}

int _compareStreams(StreamState a, StreamState b) {
  if (a.senderId != b.senderId) {
    return a.senderId - b.senderId;
  }
  return a.channel - b.channel;
}

int _compareEntries(SubscribeEntry a, SubscribeEntry b) {
  if (a.senderId != b.senderId) {
    return a.senderId - b.senderId;
  }
  return a.channel - b.channel;
}

StreamState? _findStream(ReceiverState state, int senderId, int channel) {
  for (final stream in state.streams) {
    if (stream.senderId == senderId && stream.channel == channel) {
      return stream;
    }
  }
  return null;
}
