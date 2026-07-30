// トレースベクタの照合（Dart、層 2: 決定同一）。
//
// 凍結トレース（spec/vectors/trace-shard.jsonl）を Dart の判断コアへ流し、
// 出力コマンド列が TypeScript の参照実装と**完全に一致**することを確かめる。
// 1 コマンドの相違も許さない（conformance.md 4.4）。
//
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// 動的型（dynamic）を使わない。JSON は Object? で受け、is で絞る。

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:wheso_client/src/shard_core.dart';

/// 連想配列として読む。型が違えば試験を失敗させる。
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

bool readBool(Map<String, Object?> map, String key, String where) {
  final value = map[key];
  if (value is bool) {
    return value;
  }
  throw StateError('$where: $key が真偽値ではない');
}

/// 入力行を ShardEvent に変換する。
ShardEvent toEvent(Map<String, Object?> input) {
  final kind = input['kind'];
  switch (kind) {
    case 'media':
      return MediaEvent(
        from: readInt(input, 'from', 'media'),
        ch: readInt(input, 'ch', 'media'),
        sid: readInt(input, 'sid', 'media'),
        tid: readInt(input, 'tid', 'media'),
        key: input['key'] == true,
        bytes: readInt(input, 'bytes', 'media'),
        flags: readInt(input, 'flags', 'media'),
        seq: readInt(input, 'seq', 'media'),
      );
    case 'subscribe':
      return SubscribeEvent(
        from: readInt(input, 'from', 'subscribe'),
        to: readInt(input, 'to', 'subscribe'),
        ch: readInt(input, 'ch', 'subscribe'),
        want: readBool(input, 'want', 'subscribe'),
        maxSpatialId: readInt(input, 'maxSpatialId', 'subscribe'),
        maxTemporalId: readInt(input, 'maxTemporalId', 'subscribe'),
      );
    case 'ack':
      return AckEvent(
        from: readInt(input, 'from', 'ack'),
        to: readInt(input, 'to', 'ack'),
        ch: readInt(input, 'ch', 'ack'),
        sid: readInt(input, 'sid', 'ack'),
        highestSeq: readInt(input, 'highestSeq', 'ack'),
      );
    case 'streamAnnounce':
      final rungsList = readList(input['rungs'], 'streamAnnounce rungs');
      final List<LadderRung> rungs = [];
      for (final item in rungsList) {
        final r = readMap(item, 'streamAnnounce rung');
        rungs.add(LadderRung(
          sid: readInt(r, 'sid', 'rung'),
          width: readInt(r, 'width', 'rung'),
          height: readInt(r, 'height', 'rung'),
          framerate: readInt(r, 'framerate', 'rung'),
          temporalLayers: readInt(r, 'temporalLayers', 'rung'),
          targetBitrate: readInt(r, 'targetBitrate', 'rung'),
        ));
      }
      return StreamAnnounceEvent(
        from: readInt(input, 'from', 'streamAnnounce'),
        ch: readInt(input, 'ch', 'streamAnnounce'),
        rungs: rungs,
      );
    case 'join':
      return JoinEvent(id: readInt(input, 'id', 'join'));
    case 'leave':
      return LeaveEvent(id: readInt(input, 'id', 'leave'));
    case 'link':
      final peer = input['peer'];
      final state = input['state'];
      return LinkEvent(
        peer: peer is int ? peer : 0,
        state: state is String ? state : '',
      );
    case 'timer':
      return const TimerEvent();
    case 'budget':
      return BudgetEvent(bytesPerSec: readInt(input, 'bytesPerSec', 'budget'));
    case 'report':
      final samples = readList(input['delayUs'], 'report delayUs');
      final List<int> delayUs = [];
      for (final sample in samples) {
        if (sample is! int) {
          throw StateError('report delayUs: 整数ではない');
        }
        delayUs.add(sample);
      }
      return ReportEvent(from: readInt(input, 'from', 'report'), delayUs: delayUs);
    case 'keyframeRequest':
      return KeyframeRequestEvent(
        from: readInt(input, 'from', 'keyframeRequest'),
        target: readInt(input, 'target', 'keyframeRequest'),
        ch: readInt(input, 'ch', 'keyframeRequest'),
        sid: readInt(input, 'sid', 'keyframeRequest'),
      );
  }
  throw StateError('未知のイベント: $kind');
}

/// 出力コマンドを TypeScript と同じ JSON 表現へ写す。欄名も順序も一致させる。
Map<String, Object?> toJson(ShardCommand command) {
  switch (command) {
    case ForwardCommand():
      return <String, Object?>{'kind': 'forward', 'to': command.to};
    case DropCommand():
      return <String, Object?>{'kind': 'drop', 'priority': command.priority, 'count': command.count};
    case SetTierCommand():
      return <String, Object?>{'kind': 'setTier', 'for': command.targetId, 'tier': command.tier};
    case KeyframeRequestCommand():
      return <String, Object?>{
        'kind': 'keyframeRequest',
        'for': command.targetId,
        'channel': command.channel,
        'spatialId': command.spatialId,
      };
    case AckUpstreamCommand():
      return <String, Object?>{
        'kind': 'ackUpstream',
        'to': command.to,
        'channel': command.channel,
        'spatialId': command.spatialId,
        'highestSeq': command.highestSeq,
      };
    case DisconnectCommand():
      return <String, Object?>{'kind': 'disconnect', 'peer': command.peer};
    case NotifyCommand():
      return <String, Object?>{'kind': 'notify', 'code': command.code};
  }
}

void main() {
  test('中継ノードの凍結トレースが参照実装と完全一致する', () {
    final file = File('../../spec/vectors/trace-shard.jsonl');
    final lines = file.readAsLinesSync().where((line) => line.trim().isNotEmpty).toList();
    expect(lines.length, greaterThan(100));

    final header = readMap(jsonDecode(lines.first), 'header');
    expect(header['unit'], equals('shard'));

    ShardState? state;
    Map<String, Object?>? pending;
    var checked = 0;

    for (final line in lines.skip(1)) {
      final row = readMap(jsonDecode(line), 'row');
      final input = row['in'];
      if (input != null) {
        pending = readMap(input, 'in');
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
      final t = readInt(row, 't', 'row');
      state ??= initialState(t);
      final result = step(state, toEvent(event), t);
      state = result.state;
      final actual = result.commands.map(toJson).toList();
      expect(jsonEncode(actual), equals(jsonEncode(expected)),
          reason: '入力 ${jsonEncode(event)} に対する出力が一致する');
      checked += 1;
    }
    expect(checked, greaterThan(100), reason: '十分な行数を照合した');
  });
}
