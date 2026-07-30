// 受信ノードのトレースベクタの照合（Dart、層 2: 決定同一）。
//
// 凍結トレース（spec/vectors/trace-receiver.jsonl）を Dart の判断コアへ流し、
// 出力コマンド列が TypeScript の参照実装と**完全に一致**することを確かめる。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:wheso_client/src/receiver_core.dart';

Map<String, Object?> readMap(Object? value, String where) {
  if (value is Map<String, Object?>) {
    return value;
  }
  throw StateError('$where: 連想配列ではない');
}

List<Object?> readList(Object? value, String where) {
  if (value is List<Object?>) {
    return value;
  }
  throw StateError('$where: 配列ではない');
}

int readInt(Map<String, Object?> map, String key, String where) {
  final value = map[key];
  if (value is int) {
    return value;
  }
  throw StateError('$where: $key が整数ではない');
}

ReceiverEvent toEvent(Map<String, Object?> input) {
  final kind = input['kind'];
  switch (kind) {
    case 'subscribe':
      final entries = <SubscribeEntry>[];
      for (final raw in readList(input['entries'], 'subscribe entries')) {
        final entry = readMap(raw, 'subscribe entry');
        entries.add(SubscribeEntry(
          senderId: readInt(entry, 'senderId', 'entry'),
          channel: readInt(entry, 'channel', 'entry'),
          maxSpatialId: readInt(entry, 'maxSpatialId', 'entry'),
          maxTemporalId: readInt(entry, 'maxTemporalId', 'entry'),
        ));
      }
      return SubscribeListEvent(entries: entries);
    case 'leave':
      return LeaveEvent(id: readInt(input, 'id', 'leave'));
    case 'visibility':
      final visible = input['visible'];
      if (visible is! bool) {
        throw StateError('visibility: visible が真偽値ではない');
      }
      return VisibilityEvent(visible: visible);
    case 'budget':
      return BudgetEvent(bytesPerSec: readInt(input, 'bytesPerSec', 'budget'));
    case 'goodput':
      return GoodputEvent(bytesPerSec: readInt(input, 'bytesPerSec', 'goodput'));
    case 'activeSpeaker':
      // null は「発話者なし」を意味する。欄の欠落と区別する。
      if (!input.containsKey('id')) {
        throw StateError('activeSpeaker: id が無い');
      }
      final id = input['id'];
      if (id == null) {
        return const ActiveSpeakerEvent(id: null);
      }
      if (id is! int) {
        throw StateError('activeSpeaker: id が整数でも null でもない');
      }
      return ActiveSpeakerEvent(id: id);
    case 'displaySize':
      return DisplaySizeEvent(
        senderId: readInt(input, 'senderId', 'displaySize'),
        channel: readInt(input, 'channel', 'displaySize'),
        width: readInt(input, 'width', 'displaySize'),
      );
    case 'catalog':
      final rawEntries = readList(input['entries'], 'catalog entries');
      final catalogEntries = <CatalogLadder>[];
      for (final rawEntry in rawEntries) {
        final entry = readMap(rawEntry, 'catalog entry');
        final rawRungs = readList(entry['rungs'], 'catalog rungs');
        final rungs = <CatalogRung>[];
        for (final rawRung in rawRungs) {
          final r = readMap(rawRung, 'catalog rung');
          rungs.add(CatalogRung(
            sid: readInt(r, 'sid', 'rung'),
            width: readInt(r, 'width', 'rung'),
            height: readInt(r, 'height', 'rung'),
            framerate: readInt(r, 'framerate', 'rung'),
            temporalLayers: readInt(r, 'temporalLayers', 'rung'),
            targetBitrate: readInt(r, 'targetBitrate', 'rung'),
          ));
        }
        catalogEntries.add(CatalogLadder(
          senderId: readInt(entry, 'senderId', 'catalog entry'),
          channel: readInt(entry, 'channel', 'catalog entry'),
          rungs: rungs,
        ));
      }
      return CatalogEvent(entries: catalogEntries);
    case 'report':
      final delayUs = <int>[];
      for (final sample in readList(input['delayUs'], 'report delayUs')) {
        if (sample is! int) {
          throw StateError('report delayUs: 整数ではない');
        }
        delayUs.add(sample);
      }
      return ReportEvent(delayUs: delayUs);
    case 'media':
      final seq = input['seq'];
      return MediaEvent(
        from: readInt(input, 'from', 'media'),
        ch: readInt(input, 'ch', 'media'),
        sid: readInt(input, 'sid', 'media'),
        tid: readInt(input, 'tid', 'media'),
        seq: seq is int ? seq : 0,
      );
    case 'keyframeRequest':
      return KeyframeRequestEvent(
        senderId: readInt(input, 'senderId', 'keyframeRequest'),
        channel: readInt(input, 'channel', 'keyframeRequest'),
        spatialId: readInt(input, 'spatialId', 'keyframeRequest'),
      );
    case 'timer':
      return const TimerEvent();
  }
  throw StateError('未知のイベント: $kind');
}

/// 出力コマンドを TypeScript と同じ JSON 表現へ写す。欄名も順序も一致させる。
Map<String, Object?> toJson(ReceiverCommand command) {
  switch (command) {
    case SubscribeChangeCommand():
      return <String, Object?>{
        'kind': 'subscribeChange',
        'to': command.to,
        'channel': command.channel,
        'want': command.want,
        'maxSpatialId': command.maxSpatialId,
        'maxTemporalId': command.maxTemporalId,
      };
    case KeyframeRequestCommand():
      return <String, Object?>{
        'kind': 'keyframeRequest',
        'for': command.targetId,
        'channel': command.channel,
        'spatialId': command.spatialId,
      };
    case SetTierCommand():
      return <String, Object?>{
        'kind': 'setTier',
        'for': command.targetId,
        'channel': command.channel,
        'tier': command.tier,
      };
    case ForwardCommand():
      return <String, Object?>{'kind': 'forward', 'to': command.to};
    case DropCommand():
      return <String, Object?>{'kind': 'drop', 'priority': command.priority, 'count': command.count};
    case NotifyCommand():
      return <String, Object?>{'kind': 'notify', 'code': command.code};
    case AckCommand():
      return <String, Object?>{
        'kind': 'ack',
        'senderId': command.senderId,
        'channel': command.channel,
        'spatialId': command.spatialId,
        'highestSeq': command.highestSeq,
      };
  }
}

void main() {
  test('受信ノードの凍結トレースが参照実装と完全一致する', () {
    final file = File('../../spec/vectors/trace-receiver.jsonl');
    final lines = file.readAsLinesSync().where((line) => line.trim().isNotEmpty).toList();
    expect(lines.length, greaterThan(100));

    final header = readMap(jsonDecode(lines.first), 'header');
    expect(header['unit'], equals('receiver'));

    var state = initialReceiverState();
    Map<String, Object?>? pending;
    // 入力行の時刻。AIMD の待ち（RATE_HOLD_MS）の判定に使う。
    int pendingT = 0;
    var checked = 0;

    for (final line in lines.skip(1)) {
      final row = readMap(jsonDecode(line), 'row');
      final input = row['in'];
      if (input != null) {
        pending = readMap(input, 'in');
        final rawT = row['t'];
        pendingT = rawT is int ? rawT : 0;
        continue;
      }
      final out = row['out'];
      if (out == null) {
        continue;
      }
      final expected = readList(out, 'out');
      final event = pending;
      if (event == null) {
        throw StateError('出力に対応する入力が無い');
      }
      pending = null;
      final result = receiverStep(state, toEvent(event), pendingT);
      state = result.state;
      final actual = result.commands.map(toJson).toList();
      expect(jsonEncode(actual), equals(jsonEncode(expected)),
          reason: '入力 ${jsonEncode(event)} に対する出力が一致する');
      checked += 1;
    }
    expect(checked, greaterThan(100), reason: '十分な行数を照合した');
  });
}
