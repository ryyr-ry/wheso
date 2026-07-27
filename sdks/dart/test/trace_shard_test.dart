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

/// 連想配列として読む。型が違えば試験を失敗させる（既定値へ落とさない）。
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
      );
    case 'subscribe':
      return SubscribeEvent(
        from: readInt(input, 'from', 'subscribe'),
        to: readInt(input, 'to', 'subscribe'),
        want: readBool(input, 'want', 'subscribe'),
        maxSpatialId: readInt(input, 'maxSpatialId', 'subscribe'),
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
      final delayUs = <int>[];
      for (final sample in samples) {
        if (sample is! int) {
          throw StateError('report delayUs: 整数ではない');
        }
        delayUs.add(sample);
      }
      return ReportEvent(from: readInt(input, 'from', 'report'), delayUs: delayUs);
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
    case NotifyCommand():
      return <String, Object?>{'kind': 'notify', 'code': command.code};
    case SetTierCommand():
      return <String, Object?>{'kind': 'setTier', 'for': command.targetId, 'tier': command.tier};
  }
}

void main() {
  test('中継ノードの凍結トレースが参照実装と完全一致する', () {
    final file = File('../../spec/vectors/trace-shard.jsonl');
    final lines = file.readAsLinesSync().where((line) => line.trim().isNotEmpty).toList();
    expect(lines.length, greaterThan(100));

    final header = readMap(jsonDecode(lines.first), 'header');
    expect(header['unit'], equals('shard'));

    // 初期状態の時刻はトレースの最初の t と一致させる必要がある。
    // 一致しなければ最初の窓の判定から出力が分かれる。
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
