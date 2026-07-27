// 中継ノード（shard）の判断コア（Swift）。
//
// TypeScript の参照実装（packages/core/src/shard-core.ts）と**同じ入力列から同じ出力列**を
// 返さなければならない（conformance.md 2 節の層 2）。照合は凍結トレースで行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻は入力として受け取り、内部で取得しない。
// 浮動小数点を使わない。例外を投げない。反復順序は決定的にする。

/// 輻輳状態（state-machines.md 3 節）。
public enum WhesoCongestion: String, Equatable {
    case normal = "NORMAL"
    case sheddingT2 = "SHEDDING_T2"
    case sheddingT1 = "SHEDDING_T1"
    case sheddingSpatial = "SHEDDING_SPATIAL"
    case keyOnly = "KEY_ONLY"
}

/// 購読 1 件。
public struct WhesoSubscription: Equatable {
    public let subscriberId: Int64
    public let targetId: Int64
    public let maxSpatialId: Int64

    public init(subscriberId: Int64, targetId: Int64, maxSpatialId: Int64) {
        self.subscriberId = subscriberId
        self.targetId = targetId
        self.maxSpatialId = maxSpatialId
    }
}

/// 受信者ごとの遅延勾配。分子と分母の整数対で持つ（ADR-0017）。
public struct WhesoReceiverTrend: Equatable {
    public let subscriberId: Int64
    public let numerator: Int64
    public let denominator: Int64
}

/// 送信者とチャネルごとの最大 spatialId。
public struct WhesoMaxSpatial: Equatable {
    public let from: Int64
    public let ch: Int64
    public let sid: Int64
}

/// 送信者 1 人に指令したエンコーダの上限層（ADR-0022）。
public struct WhesoEncoderTier: Equatable {
    public let targetId: Int64
    public let tier: Int64
}

public struct WhesoShardState: Equatable {
    public var congestion: WhesoCongestion
    public var congestionEnteredAt: Int64
    public var participants: [Int64]
    public var subscriptions: [WhesoSubscription]
    public var budgetBytesPerSec: Int64
    public var sentBytesInWindow: Int64
    public var sentMessagesInWindow: Int64
    public var windowStartMs: Int64
    public var unexpectedEvents: [String]
    public var trends: [WhesoReceiverTrend]
    public var maxSpatial: [WhesoMaxSpatial]
    public var encoderTiers: [WhesoEncoderTier]
}

/// 入力イベント。
public enum WhesoShardEvent: Equatable {
    case media(from: Int64, ch: Int64, sid: Int64, tid: Int64, key: Bool, bytes: Int64, flags: Int64)
    case subscribe(from: Int64, to: Int64, want: Bool, maxSpatialId: Int64)
    case join(id: Int64)
    case leave(id: Int64)
    case link(peer: Int64, state: String)
    case timer
    case budget(bytesPerSec: Int64)
    case report(from: Int64, delayUs: [Int64])
}

/// 出力コマンド。
public enum WhesoShardCommand: Equatable {
    case forward(to: [Int64])
    case drop(priority: Int64, count: Int64)
    case notify(code: Int64)
    case setTier(targetId: Int64, tier: Int64)
}

public struct WhesoShardStepResult: Equatable {
    public let state: WhesoShardState
    public let commands: [WhesoShardCommand]
}

/// 初期状態。トレースの最初の時刻を渡す。
public func whesoInitialShardState(_ t: Int64) -> WhesoShardState {
    WhesoShardState(
        congestion: .normal,
        congestionEnteredAt: t,
        participants: [],
        subscriptions: [],
        budgetBytesPerSec: WhesoConstants.NODE_MAX_OUT_BYTES_PER_SEC,
        sentBytesInWindow: 0,
        sentMessagesInWindow: 0,
        windowStartMs: t,
        unexpectedEvents: [],
        trends: [],
        maxSpatial: [],
        encoderTiers: []
    )
}

/// 1 ステップの状態遷移。
public func whesoShardStep(
    _ state: WhesoShardState,
    _ event: WhesoShardEvent,
    _ t: Int64
) -> WhesoShardStepResult {
    switch event {
    case .media(let from, let ch, let sid, let tid, _, let bytes, let flags):
        return handleMedia(state, from: from, ch: ch, sid: sid, tid: tid, bytes: bytes, flags: flags, t: t)
    case .subscribe(let from, let to, let want, let maxSpatialId):
        return handleSubscribe(state, from: from, to: to, want: want, maxSpatialId: maxSpatialId)
    case .join(let id):
        return handleJoin(state, id: id)
    case .leave(let id):
        return handleLeave(state, id: id)
    case .link:
        // 表に無いイベントは無視して記録する。
        var next = state
        next.unexpectedEvents.append("link")
        return WhesoShardStepResult(state: next, commands: [])
    case .timer:
        return evaluateCongestion(maybeResetWindow(state, t), t)
    case .budget(let bytesPerSec):
        var next = state
        next.budgetBytesPerSec = bytesPerSec
        return evaluateCongestion(next, t)
    case .report(let from, let delayUs):
        return handleReport(state, from: from, delayUs: delayUs, t: t)
    }
}

/// 1 秒窓の更新。窓が明けたら計数を 0 に戻す。
private func maybeResetWindow(_ state: WhesoShardState, _ t: Int64) -> WhesoShardState {
    if t - state.windowStartMs < WhesoConstants.SHARD_UTIL_WINDOW_MS {
        return state
    }
    var next = state
    next.sentBytesInWindow = 0
    next.sentMessagesInWindow = 0
    next.windowStartMs = t
    return next
}

/// 送信者とチャネルごとの最大 spatialId を更新する。
private func updateMaxSpatial(_ state: WhesoShardState, from: Int64, ch: Int64, sid: Int64) -> WhesoShardState {
    if let existing = state.maxSpatial.first(where: { $0.from == from && $0.ch == ch }), existing.sid >= sid {
        return state
    }
    var next = state
    next.maxSpatial = (state.maxSpatial.filter { !($0.from == from && $0.ch == ch) }
        + [WhesoMaxSpatial(from: from, ch: ch, sid: sid)])
        .sorted { ($0.from, $0.ch) < ($1.from, $1.ch) }
    return next
}

private func maxSpatialFor(_ state: WhesoShardState, from: Int64, ch: Int64) -> Int64 {
    state.maxSpatial.first(where: { $0.from == from && $0.ch == ch })?.sid ?? 0
}

/**
 メディアの転送。

 判定の順序を参照実装に揃える。順序を変えると出力が変わる。
   1. 窓の更新と観測した最大 spatialId の更新
   2. 輻輳状態による破棄
   3. 購読者の抽出（tier を満たす者のみ、昇順）
   4. 予算超過なら破棄可能なものを破棄
   5. 転送し、計数を進めてから輻輳を再評価する
 */
private func handleMedia(
    _ state: WhesoShardState,
    from: Int64,
    ch: Int64,
    sid: Int64,
    tid: Int64,
    bytes: Int64,
    flags: Int64,
    t: Int64
) -> WhesoShardStepResult {
    let windowed = maybeResetWindow(state, t)
    let next = updateMaxSpatial(windowed, from: from, ch: ch, sid: sid)
    let priority = whesoDropPriority(channel: UInt8(truncatingIfNeeded: ch), flags: UInt8(truncatingIfNeeded: flags))
    let priorityValue: Int64? = priority.map { Int64($0) }

    if shouldDropInCongestion(next, sid: sid, tid: tid, from: from, ch: ch, priority: priorityValue) {
        return WhesoShardStepResult(
            state: next,
            commands: [.drop(priority: priorityValue ?? 0, count: 1)]
        )
    }

    let targets = next.subscriptions
        .filter { $0.targetId == from && sid <= $0.maxSpatialId }
        .map { $0.subscriberId }
        .sorted()

    if targets.isEmpty {
        return WhesoShardStepResult(state: next, commands: [])
    }

    let msgCost = Int64(targets.count)
    let byteCost = msgCost * bytes
    let projectedMessages = next.sentMessagesInWindow + msgCost
    let projectedBytes = next.sentBytesInWindow + byteCost

    if isOverBudget(projectedMessages, projectedBytes, next, t), let value = priorityValue {
        return WhesoShardStepResult(state: next, commands: [.drop(priority: value, count: 1)])
    }

    var afterForward = next
    afterForward.sentBytesInWindow = next.sentBytesInWindow + byteCost
    afterForward.sentMessagesInWindow = next.sentMessagesInWindow + msgCost
    let evaluated = evaluateCongestion(afterForward, t)
    return WhesoShardStepResult(
        state: evaluated.state,
        commands: [.forward(to: targets)] + evaluated.commands
    )
}

/// 輻輳状態による破棄の判定。破棄禁止（音声とキーフレーム）は常に転送する。
private func shouldDropInCongestion(
    _ state: WhesoShardState,
    sid: Int64,
    tid: Int64,
    from: Int64,
    ch: Int64,
    priority: Int64?
) -> Bool {
    guard let priority else {
        return false
    }
    switch state.congestion {
    case .normal:
        return false
    case .sheddingT2:
        return priority <= 3
    case .sheddingT1:
        return tid >= 1
    case .sheddingSpatial:
        // (送信者, チャネル) ごとの最大 spatialId のみを破棄する。
        // 全層を破棄すると受信側の復号が完全に止まる。
        return sid >= maxSpatialFor(state, from: from, ch: ch) || tid >= 1
    case .keyOnly:
        return true
    }
}

/// 窓内の予算を超えるか。時刻の差で正規化する（浮動小数点を使わない）。
private func isOverBudget(
    _ projectedMessages: Int64,
    _ projectedBytes: Int64,
    _ state: WhesoShardState,
    _ t: Int64
) -> Bool {
    let window = t - state.windowStartMs
    if window <= 0 {
        return false
    }
    let messageOver = projectedMessages * 1000 > WhesoConstants.NODE_MAX_OUT_MESSAGES_PER_SEC * window
    let byteOver = projectedBytes * 1000 > state.budgetBytesPerSec * window
    return messageOver || byteOver
}

private func handleSubscribe(
    _ state: WhesoShardState,
    from: Int64,
    to: Int64,
    want: Bool,
    maxSpatialId: Int64
) -> WhesoShardStepResult {
    let filtered = state.subscriptions.filter { !($0.subscriberId == from && $0.targetId == to) }
    var next = state
    if want {
        next.subscriptions = (filtered
            + [WhesoSubscription(subscriberId: from, targetId: to, maxSpatialId: maxSpatialId)])
            .sorted { ($0.subscriberId, $0.targetId) < ($1.subscriberId, $1.targetId) }
    } else {
        next.subscriptions = filtered
    }
    return withEncoderTiers(next)
}

/**
 購読の和集合から送信者ごとの必要な上限層を求め、変化した送信者へ setTier を出す。
 出力の順序は targetId の昇順に固定する（conformance.md 4.4 の完全一致）。
 */
private func withEncoderTiers(_ state: WhesoShardState) -> WhesoShardStepResult {
    var targets: [Int64] = []
    for sub in state.subscriptions where !targets.contains(sub.targetId) {
        targets.append(sub.targetId)
    }
    targets.sort()

    var nextTiers: [WhesoEncoderTier] = []
    var commands: [WhesoShardCommand] = []
    for targetId in targets {
        var tier: Int64 = 0
        for sub in state.subscriptions where sub.targetId == targetId && sub.maxSpatialId > tier {
            tier = sub.maxSpatialId
        }
        nextTiers.append(WhesoEncoderTier(targetId: targetId, tier: tier))
        let previous = state.encoderTiers.first(where: { $0.targetId == targetId })
        // 購読者が居なくなった送信者には指令を出さない（記録のみ除去する）。
        if previous == nil || previous?.tier != tier {
            commands.append(.setTier(targetId: targetId, tier: tier))
        }
    }
    var next = state
    next.encoderTiers = nextTiers
    return WhesoShardStepResult(state: next, commands: commands)
}

private func handleJoin(_ state: WhesoShardState, id: Int64) -> WhesoShardStepResult {
    if state.participants.contains(id) {
        return WhesoShardStepResult(state: state, commands: [])
    }
    var next = state
    next.participants = (state.participants + [id]).sorted()
    return WhesoShardStepResult(state: next, commands: [])
}

private func handleLeave(_ state: WhesoShardState, id: Int64) -> WhesoShardStepResult {
    var next = state
    next.participants = state.participants.filter { $0 != id }
    next.subscriptions = state.subscriptions.filter { $0.subscriberId != id && $0.targetId != id }
    // 退出者の遅延勾配と観測した spatialId も除去する。
    // 残すと、居なくなった相手の古い観測が輻輳の判定に影響し続ける。
    next.trends = state.trends.filter { $0.subscriberId != id }
    next.maxSpatial = state.maxSpatial.filter { $0.from != id }
    // 退出者への指令の記録も除去する。残すと再参加時に指令が出ない。
    next.encoderTiers = state.encoderTiers.filter { $0.targetId != id }
    return withEncoderTiers(next)
}

private func handleReport(
    _ state: WhesoShardState,
    from: Int64,
    delayUs: [Int64],
    t: Int64
) -> WhesoShardStepResult {
    let slope = whesoDelaySlope(delayUs)
    var next = state
    next.trends = (state.trends.filter { $0.subscriberId != from }
        + [WhesoReceiverTrend(subscriberId: from, numerator: slope.numerator, denominator: slope.denominator)])
        .sorted { $0.subscriberId < $1.subscriberId }
    return evaluateCongestion(next, t)
}

private func utilGreater(_ state: WhesoShardState, _ t: Int64, _ num: Int64, _ den: Int64) -> Bool {
    let window = t - state.windowStartMs
    if window <= 0 {
        return false
    }
    return state.sentMessagesInWindow * 1000 * den > num * window * WhesoConstants.NODE_MAX_OUT_MESSAGES_PER_SEC
}

private func utilLess(_ state: WhesoShardState, _ t: Int64, _ num: Int64, _ den: Int64) -> Bool {
    let window = t - state.windowStartMs
    if window <= 0 {
        // 窓が始まっていない場合は利用率 0 とみなす。閾値が正なら下回る。
        return num > 0
    }
    return state.sentMessagesInWindow * 1000 * den < num * window * WhesoConstants.NODE_MAX_OUT_MESSAGES_PER_SEC
}

/// 1 人でも閾値を超えるか（劣化は OR で評価する）。
private func trendGreater(_ state: WhesoShardState, _ num: Int64, _ den: Int64) -> Bool {
    state.trends.contains { $0.numerator * den > num * $0.denominator }
}

/// 全員が閾値を下回るか（回復は AND で評価する）。記録が無い場合は真とする。
private func trendLess(_ state: WhesoShardState, _ num: Int64, _ den: Int64) -> Bool {
    state.trends.allSatisfy { $0.numerator * den < num * $0.denominator }
}

/// 輻輳状態の評価（state-machines.md 3 節）。ヒステリシスの間は遷移しない。
private func evaluateCongestion(_ state: WhesoShardState, _ t: Int64) -> WhesoShardStepResult {
    if t - state.congestionEnteredAt < WhesoConstants.SHEDDING_HYSTERESIS_MS {
        return WhesoShardStepResult(state: state, commands: [])
    }
    let nextPhase: WhesoCongestion
    switch state.congestion {
    case .normal:
        if utilGreater(state, t, WhesoConstants.SHARD_UTIL_ENTER_T2_NUM, WhesoConstants.SHARD_UTIL_ENTER_T2_DEN)
            || trendGreater(state, WhesoConstants.SHARD_TREND_ENTER_T2_NUM, WhesoConstants.SHARD_TREND_ENTER_T2_DEN) {
            nextPhase = .sheddingT2
        } else {
            nextPhase = .normal
        }
    case .sheddingT2:
        if utilGreater(state, t, WhesoConstants.SHARD_UTIL_ENTER_T1_NUM, WhesoConstants.SHARD_UTIL_ENTER_T1_DEN)
            || trendGreater(state, WhesoConstants.SHARD_TREND_ENTER_T1_NUM, WhesoConstants.SHARD_TREND_ENTER_T1_DEN) {
            nextPhase = .sheddingT1
        } else if utilLess(state, t, WhesoConstants.SHARD_UTIL_EXIT_T2_NUM, WhesoConstants.SHARD_UTIL_EXIT_T2_DEN)
            && trendLess(state, WhesoConstants.SHARD_TREND_EXIT_NUM, WhesoConstants.SHARD_TREND_EXIT_DEN) {
            nextPhase = .normal
        } else {
            nextPhase = .sheddingT2
        }
    case .sheddingT1:
        if utilGreater(state, t, WhesoConstants.SHARD_UTIL_ENTER_SPATIAL_NUM, WhesoConstants.SHARD_UTIL_ENTER_SPATIAL_DEN)
            || trendGreater(state, WhesoConstants.SHARD_TREND_ENTER_SPATIAL_NUM, WhesoConstants.SHARD_TREND_ENTER_SPATIAL_DEN) {
            nextPhase = .sheddingSpatial
        } else if utilLess(state, t, WhesoConstants.SHARD_UTIL_EXIT_T1_NUM, WhesoConstants.SHARD_UTIL_EXIT_T1_DEN)
            && trendLess(state, WhesoConstants.SHARD_TREND_EXIT_NUM, WhesoConstants.SHARD_TREND_EXIT_DEN) {
            nextPhase = .sheddingT2
        } else {
            nextPhase = .sheddingT1
        }
    case .sheddingSpatial:
        if utilGreater(state, t, WhesoConstants.SHARD_UTIL_ENTER_KEY_ONLY_NUM, WhesoConstants.SHARD_UTIL_ENTER_KEY_ONLY_DEN)
            || trendGreater(state, WhesoConstants.SHARD_TREND_ENTER_KEY_ONLY_NUM, WhesoConstants.SHARD_TREND_ENTER_KEY_ONLY_DEN) {
            nextPhase = .keyOnly
        } else if utilLess(state, t, WhesoConstants.SHARD_UTIL_EXIT_SPATIAL_NUM, WhesoConstants.SHARD_UTIL_EXIT_SPATIAL_DEN)
            && trendLess(state, WhesoConstants.SHARD_TREND_EXIT_NUM, WhesoConstants.SHARD_TREND_EXIT_DEN) {
            nextPhase = .sheddingT1
        } else {
            nextPhase = .sheddingSpatial
        }
    case .keyOnly:
        if utilLess(state, t, WhesoConstants.SHARD_UTIL_EXIT_KEY_ONLY_NUM, WhesoConstants.SHARD_UTIL_EXIT_KEY_ONLY_DEN)
            && trendLess(state, WhesoConstants.SHARD_TREND_EXIT_KEY_ONLY_NUM, WhesoConstants.SHARD_TREND_EXIT_KEY_ONLY_DEN) {
            nextPhase = .sheddingSpatial
        } else {
            nextPhase = .keyOnly
        }
    }
    if nextPhase == state.congestion {
        return WhesoShardStepResult(state: state, commands: [])
    }
    var commands: [WhesoShardCommand] = []
    if nextPhase == .keyOnly {
        // 過負荷を制御系へ知らせる。接続は閉じない。
        commands.append(.notify(code: WhesoErrors.E_NODE_OVERLOADED_CLOSE_CODE))
    }
    var next = state
    next.congestion = nextPhase
    next.congestionEnteredAt = t
    return WhesoShardStepResult(state: next, commands: commands)
}
