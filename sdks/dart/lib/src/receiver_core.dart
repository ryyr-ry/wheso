// 受信ノード（receiver）の判断コア（Dart）。
//
// 規範: state-machines.md 2 節（購読と tier）、congestion.md 4.3（tier の選択）、
// conformance.md 4 節（入力イベントと出力コマンド）。
//
// TypeScript の参照実装（packages/core/src/receiver-core.ts）と**同一の出力**を
// 返さなければならない。照合は凍結トレース（spec/vectors/trace-receiver.jsonl）で行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻・乱数・浮動小数点・入出力に触れない。除算は整数の切り捨てのみを使う。

import 'fixed.dart' show delaySlope, truncDiv, Slope;
import 'generated/constants.dart' as constants;

/// 品質低下の警告。文言は利用側が国際化キーから作る（sdk-api.md 6 節）。
const String _degradedWarning = 'W_DEGRADED';

/// 受信者自身の識別子。転送先は常にこの 1 人である。
const int receiverSelfId = 0;

/// (senderId, channel) ごとの購読状態（state-machines.md 2 節）。
enum StreamPhase { unsubscribed, subscribed, paused }

/// 1 本のストリームの状態。
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

  /// 現在要求している最大 spatialId。
  final int spatialId;

  /// 現在要求している最大 temporalId。
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

class ReceiverState {
  const ReceiverState({
    required this.streams,
    required this.visible,
    required this.targetBytesPerSec,
    required this.activeSpeakerId,
    required this.trend,
    required this.degraded,
    required this.unexpectedEvents,
    required this.received,
  });

  /// senderId, channel の昇順で保持する。反復順序が判断に影響するため決定的にする。
  final List<StreamState> streams;
  final bool visible;
  final int targetBytesPerSec;
  final int? activeSpeakerId;
  final Slope trend;
  final bool degraded;
  final List<String> unexpectedEvents;

  /// senderId, channel, spatialId の昇順で保持する。
  final List<ReceivedMark> received;

  ReceiverState copyWith({
    List<StreamState>? streams,
    bool? visible,
    int? targetBytesPerSec,
    int? activeSpeakerId,
    bool clearActiveSpeaker = false,
    Slope? trend,
    bool? degraded,
    List<String>? unexpectedEvents,
    List<ReceivedMark>? received,
  }) {
    return ReceiverState(
      streams: streams ?? List.of(this.streams),
      visible: visible ?? this.visible,
      targetBytesPerSec: targetBytesPerSec ?? this.targetBytesPerSec,
      // 発話者は null を取り得るため、消去を別の旗で表す（?? では消せない）。
      activeSpeakerId: clearActiveSpeaker ? null : (activeSpeakerId ?? this.activeSpeakerId),
      trend: trend ?? this.trend,
      degraded: degraded ?? this.degraded,
      unexpectedEvents: unexpectedEvents ?? List.of(this.unexpectedEvents),
      received: received ?? List.of(this.received),
    );
  }
}

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

/// 入力イベント。sealed で閉じる（判定漏れを防ぐ）。
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

class BudgetEvent implements ReceiverEvent {
  const BudgetEvent({required this.bytesPerSec});
  final int bytesPerSec;
}

class ActiveSpeakerEvent implements ReceiverEvent {
  const ActiveSpeakerEvent({required this.id});
  final int? id;
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

  /// 受信した sequenceNumber。ack の算出に使う。既定は 0（不明）。
  final int seq;
}

class TimerEvent implements ReceiverEvent {
  const TimerEvent();
}

/// 出力コマンド。sealed で閉じる。
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

ReceiverState initialReceiverState(int targetBytesPerSec) {
  return ReceiverState(
    streams: <StreamState>[],
    visible: true,
    targetBytesPerSec: targetBytesPerSec,
    activeSpeakerId: null,
    trend: const Slope(0, 1),
    degraded: false,
    unexpectedEvents: <String>[],
    received: <ReceivedMark>[],
  );
}

/// 純関数の状態遷移。
ReceiverStepResult receiverStep(ReceiverState state, ReceiverEvent event) {
  switch (event) {
    case SubscribeListEvent():
      return _handleSubscribe(state, event.entries);
    case LeaveEvent():
      return _handleLeave(state, event.id);
    case VisibilityEvent():
      return _handleVisibility(state, event.visible);
    case BudgetEvent():
      return _reallocate(state.copyWith(targetBytesPerSec: event.bytesPerSec));
    case ActiveSpeakerEvent():
      final id = event.id;
      return _reallocate(
        id == null ? state.copyWith(clearActiveSpeaker: true) : state.copyWith(activeSpeakerId: id),
      );
    case DisplaySizeEvent():
      return _handleDisplaySize(state, event.senderId, event.channel, event.width);
    case ReportEvent():
      return _handleReport(state, event.delayUs);
    case MediaEvent():
      return _handleMedia(state, event);
    case TimerEvent():
      // ACK_INTERVAL_MS ごとに、受信済みの位置を ack として返す。
      // 呼び出し側が周期を管理する（コアは時刻を持たない）。
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

/// spatialId の範囲は最低品質から最高品質までである。
int _clampSpatial(int value) {
  if (value < constants.V_360P15_SPATIAL_ID) {
    return constants.V_360P15_SPATIAL_ID;
  }
  if (value > constants.V_4K60_SPATIAL_ID) {
    return constants.V_4K60_SPATIAL_ID;
  }
  return value;
}

/// 購読一覧の適用。表 1 行目と 2 行目に対応する。
ReceiverStepResult _handleSubscribe(ReceiverState state, List<SubscribeEntry> entries) {
  final commands = <ReceiverCommand>[];
  final kept = <StreamState>[];

  final sorted = List.of(entries)..sort(_compareEntries);
  for (final entry in sorted) {
    final existing = _findStream(state, entry.senderId, entry.channel);
    if (existing == null || existing.phase == StreamPhase.unsubscribed) {
      commands.add(SubscribeChangeCommand(
        to: entry.senderId,
        channel: entry.channel,
        want: true,
        maxSpatialId: entry.maxSpatialId,
        maxTemporalId: entry.maxTemporalId,
      ));
      commands.add(KeyframeRequestCommand(
        targetId: entry.senderId,
        channel: entry.channel,
        spatialId: entry.maxSpatialId,
      ));
      kept.add(StreamState(
        senderId: entry.senderId,
        channel: entry.channel,
        phase: StreamPhase.subscribed,
        spatialId: entry.maxSpatialId,
        temporalId: entry.maxTemporalId,
        displayWidth: existing == null ? 0 : existing.displayWidth,
      ));
      continue;
    }
    kept.add(existing.copyWith(phase: StreamPhase.subscribed));
  }

  // 一覧から外れたものは購読解除する（表 2 行目）。
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

/// 送信者の退出。表 6 行目に対応する。
ReceiverStepResult _handleLeave(ReceiverState state, int id) {
  final streams = state.streams.where((stream) => stream.senderId != id).toList();
  if (streams.length == state.streams.length) {
    return ReceiverStepResult(state: state, commands: <ReceiverCommand>[]);
  }
  // 退出者の受信位置も除去する。残すと居ない相手へ ack を返し続ける。
  final received = state.received.where((mark) => mark.senderId != id).toList();
  return _reallocate(state.copyWith(streams: streams, received: received));
}

/// 表示・非表示。表 7 行目と 8 行目に対応する。
ReceiverStepResult _handleVisibility(ReceiverState state, bool visible) {
  if (visible == state.visible) {
    return ReceiverStepResult(state: state, commands: <ReceiverCommand>[]);
  }
  final commands = <ReceiverCommand>[];
  final streams = <StreamState>[];
  for (final stream in state.streams) {
    if (!visible && stream.phase == StreamPhase.subscribed) {
      // 非表示では購読を解除するが、状態は保持する（PAUSED）。
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

/// 表示寸法の申告。未申告の相手は最低品質に留める（ADR-0015）。
ReceiverStepResult _handleDisplaySize(ReceiverState state, int senderId, int channel, int width) {
  if (_findStream(state, senderId, channel) == null) {
    final unexpected = List.of(state.unexpectedEvents)..add('displaySize');
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

/// 測定報告。勾配が劣化閾値を超えたら tier を 1 段下げ、回復閾値を下回ったら 1 段上げる。
ReceiverStepResult _handleReport(ReceiverState state, List<int> delayUs) {
  final trend = delaySlope(delayUs);
  final degrading = trend.numerator * constants.SHARD_TREND_ENTER_T2_DEN >
      constants.SHARD_TREND_ENTER_T2_NUM * trend.denominator;
  final recovering = trend.numerator * constants.SHARD_TREND_EXIT_DEN <
      constants.SHARD_TREND_EXIT_NUM * trend.denominator;
  if (!degrading && !recovering) {
    return ReceiverStepResult(state: state.copyWith(trend: trend), commands: <ReceiverCommand>[]);
  }
  final delta = degrading ? -1 : 1;
  final commands = <ReceiverCommand>[];
  final streams = <StreamState>[];
  for (final stream in state.streams) {
    if (stream.phase != StreamPhase.subscribed) {
      streams.add(stream);
      continue;
    }
    final nextSpatial = _clampSpatial(stream.spatialId + delta);
    if (nextSpatial == stream.spatialId) {
      streams.add(stream);
      continue;
    }
    streams.add(stream.copyWith(spatialId: nextSpatial));
    commands.add(SetTierCommand(targetId: stream.senderId, channel: stream.channel, tier: nextSpatial));
    // spatialId が変わる場合のみキーフレームを要求する（表 4 行目と 3 行目の違い）。
    if (nextSpatial > stream.spatialId) {
      commands.add(KeyframeRequestCommand(
        targetId: stream.senderId,
        channel: stream.channel,
        spatialId: nextSpatial,
      ));
    }
  }
  return ReceiverStepResult(
    state: state.copyWith(trend: trend, streams: streams),
    commands: commands,
  );
}

/// メディアの転送。要求 tier を超えるユニットは転送しない。
ReceiverStepResult _handleMedia(ReceiverState state, MediaEvent event) {
  final stream = _findStream(state, event.from, event.ch);
  if (stream == null || stream.phase != StreamPhase.subscribed) {
    return ReceiverStepResult(state: state, commands: <ReceiverCommand>[]);
  }
  if (event.sid > stream.spatialId || event.tid > stream.temporalId) {
    return ReceiverStepResult(
      state: state,
      commands: <ReceiverCommand>[const DropCommand(priority: 1, count: 1)],
    );
  }
  // 受信した位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
  return ReceiverStepResult(
    state: _markReceived(state, event),
    commands: <ReceiverCommand>[const ForwardCommand(to: <int>[receiverSelfId])],
  );
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

/// 発話者を先に、次に senderId の昇順で並べる。順序は決定的でなければならない。
int _comparePriority(ReceiverState state, StreamState a, StreamState b) {
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

/// 帯域予算から tier を配分する（congestion.md 4.3）。
///
/// 除算は整数で行い、切り捨てる。浮動小数点を使わない（ADR-0017）。
ReceiverStepResult _reallocate(ReceiverState state) {
  final commands = <ReceiverCommand>[];
  final budgetResult = truncDiv(state.targetBytesPerSec * 8 * 9, 10);
  final budgetBps = budgetResult.isOk ? budgetResult.value ?? 0 : 0;
  final highQualityResult = truncDiv(budgetBps, constants.V_4K60_TARGET_BITRATE);
  final highQualityCount = highQualityResult.isOk ? highQualityResult.value ?? 0 : 0;
  final thumbnailCost = constants.V_360P15_TARGET_BITRATE;

  final ordered = state.streams.where((stream) => stream.phase == StreamPhase.subscribed).toList()
    ..sort((a, b) => _comparePriority(state, a, b));

  final streams = <StreamState>[];
  var assignedHigh = 0;
  var remaining = budgetBps;
  var degraded = false;

  for (final stream in state.streams) {
    if (stream.phase != StreamPhase.subscribed) {
      streams.add(stream);
      continue;
    }
    var rank = -1;
    for (var index = 0; index < ordered.length; index += 1) {
      final candidate = ordered[index];
      if (candidate.senderId == stream.senderId && candidate.channel == stream.channel) {
        rank = index;
        break;
      }
    }
    final int nextSpatial;
    if (stream.displayWidth == 0) {
      // 表示寸法の申告が無い相手は最低品質に留める（ADR-0015）。
      nextSpatial = constants.DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID;
    } else if (assignedHigh < highQualityCount && rank < highQualityCount) {
      nextSpatial = constants.V_4K60_SPATIAL_ID;
      assignedHigh += 1;
      remaining -= constants.V_4K60_TARGET_BITRATE;
    } else if (remaining >= thumbnailCost) {
      nextSpatial = constants.V_360P15_SPATIAL_ID;
      remaining -= thumbnailCost;
    } else {
      // 予算が尽きた。発話者のサムネイルのみを維持する（最低保証）。
      nextSpatial = constants.V_360P15_SPATIAL_ID;
      degraded = true;
    }
    if (nextSpatial != stream.spatialId) {
      commands.add(SetTierCommand(targetId: stream.senderId, channel: stream.channel, tier: nextSpatial));
      if (nextSpatial > stream.spatialId) {
        // spatialId が上がる場合はエンコーダ出力が切り替わるためキーフレームが必要である。
        commands.add(KeyframeRequestCommand(
          targetId: stream.senderId,
          channel: stream.channel,
          spatialId: nextSpatial,
        ));
      }
    }
    streams.add(stream.copyWith(spatialId: nextSpatial));
  }

  if (degraded && !state.degraded) {
    // 最低保証（発話者のサムネイル 1 本と全員の音声）を下回った。利用側へ警告する。
    commands.add(const NotifyCommand(code: _degradedWarning));
  }

  streams.sort(_compareStreams);
  return ReceiverStepResult(
    state: state.copyWith(streams: streams, degraded: degraded),
    commands: commands,
  );
}
