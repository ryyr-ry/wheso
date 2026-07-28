// 受信ノード（receiver）の判断コア（Swift）。
//
// 規範: state-machines.md 2 節（購読と tier）、congestion.md 4.3（tier の選択）。
// TypeScript の参照実装（packages/core/src/receiver-core.ts）と**同一の出力**を返さなければ
// ならない。照合は凍結トレース（spec/vectors/trace-receiver.jsonl）で行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻・乱数・浮動小数点・入出力に触れない。除算は整数の切り捨てのみを使う。

/// 品質低下の警告。文言は利用側が国際化キーから作る（sdk-api.md 6 節）。
private let degradedWarning = "W_DEGRADED"

/// 受信者自身の識別子。転送先は常にこの 1 人である。
public let whesoReceiverSelfId: Int64 = 0

/// (senderId, channel) ごとの購読状態（state-machines.md 2 節）。
public enum WhesoStreamPhase: String, Equatable {
    case unsubscribed = "UNSUBSCRIBED"
    case subscribed = "SUBSCRIBED"
    case paused = "PAUSED"
}

/// 1 本のストリームの状態。
public struct WhesoStreamState: Equatable {
    public var senderId: Int64
    public var channel: Int64
    public var phase: WhesoStreamPhase
    /// 現在要求している最大 spatialId。
    public var spatialId: Int64
    /// 現在要求している最大 temporalId。
    public var temporalId: Int64
    /// 利用側が申告した表示寸法（論理画素）。未申告は 0。
    public var displayWidth: Int64
}

/// 受信済みの位置。ack の内容になる。
public struct WhesoReceivedMark: Equatable {
    public let senderId: Int64
    public let channel: Int64
    public let spatialId: Int64
    public let highestSeq: Int64
}

public struct WhesoReceiverState: Equatable {
    /// senderId, channel の昇順で保持する。反復順序が判断に影響するため決定的にする。
    public var streams: [WhesoStreamState]
    public var visible: Bool
    public var targetBytesPerSec: Int64
    public var activeSpeakerId: Int64?
    public var trend: WhesoSlope
    public var degraded: Bool
    public var unexpectedEvents: [String]
    /// senderId, channel, spatialId の昇順で保持する。
    public var received: [WhesoReceivedMark]
    /// 次に減少の判定を行える時刻（AIMD。congestion 4.2）。
    public var rateHoldUntilMs: Int64
    /// 回復判定が連続した回数。規範は 3 回連続で加算的増加を許す。
    public var recoverStreak: Int64
    /// 目標ビットレートの上限（bytes/sec）。加算的増加はこれを超えない。
    public var targetCeilingBytesPerSec: Int64
}

public struct WhesoSubscribeEntry: Equatable {
    public let senderId: Int64
    public let channel: Int64
    public let maxSpatialId: Int64
    public let maxTemporalId: Int64

    public init(senderId: Int64, channel: Int64, maxSpatialId: Int64, maxTemporalId: Int64) {
        self.senderId = senderId
        self.channel = channel
        self.maxSpatialId = maxSpatialId
        self.maxTemporalId = maxTemporalId
    }
}

/// 入力イベント。
public enum WhesoReceiverEvent: Equatable {
    case subscribeList(entries: [WhesoSubscribeEntry])
    case leave(id: Int64)
    case visibility(visible: Bool)
    case budget(bytesPerSec: Int64)
    case activeSpeaker(id: Int64?)
    case displaySize(senderId: Int64, channel: Int64, width: Int64)
    case report(delayUs: [Int64])
    case media(from: Int64, ch: Int64, sid: Int64, tid: Int64, seq: Int64)
    case timer
}

/// 出力コマンド。
public enum WhesoReceiverCommand: Equatable {
    case subscribeChange(to: Int64, channel: Int64, want: Bool, maxSpatialId: Int64, maxTemporalId: Int64)
    case keyframeRequest(targetId: Int64, channel: Int64, spatialId: Int64)
    case setTier(targetId: Int64, channel: Int64, tier: Int64)
    case forward(to: [Int64])
    case drop(priority: Int64, count: Int64)
    case notify(code: String)
    case ack(senderId: Int64, channel: Int64, spatialId: Int64, highestSeq: Int64)
}

public struct WhesoReceiverStepResult: Equatable {
    public let state: WhesoReceiverState
    public let commands: [WhesoReceiverCommand]
}

public func whesoInitialReceiverState(_ targetBytesPerSec: Int64) -> WhesoReceiverState {
    WhesoReceiverState(
        streams: [],
        visible: true,
        targetBytesPerSec: targetBytesPerSec,
        activeSpeakerId: nil,
        trend: WhesoSlope(numerator: 0, denominator: 1),
        degraded: false,
        unexpectedEvents: [],
        received: [],
        rateHoldUntilMs: 0,
        recoverStreak: 0,
        // 初めに与えられた値が上限である。回復してもこれを超えて要求しない。
        targetCeilingBytesPerSec: targetBytesPerSec
    )
}

/// 純関数の状態遷移。
/// 純関数の状態遷移。時刻は AIMD の待ち（RATE_HOLD_MS）に使う。
public func whesoReceiverStep(
    _ state: WhesoReceiverState,
    _ event: WhesoReceiverEvent,
    _ t: Int64 = 0
) -> WhesoReceiverStepResult {
    switch event {
    case .subscribeList(let entries):
        return handleSubscribeList(state, entries)
    case .leave(let id):
        return handleLeave(state, id)
    case .visibility(let visible):
        return handleVisibility(state, visible)
    case .budget(let bytesPerSec):
        var next = state
        next.targetBytesPerSec = bytesPerSec
        return reallocate(next)
    case .activeSpeaker(let id):
        var next = state
        next.activeSpeakerId = id
        return reallocate(next)
    case .displaySize(let senderId, let channel, let width):
        return handleDisplaySize(state, senderId: senderId, channel: channel, width: width)
    case .report(let delayUs):
        return handleReport(state, delayUs, t)
    case .media(let from, let ch, let sid, let tid, let seq):
        return handleMedia(state, from: from, ch: ch, sid: sid, tid: tid, seq: seq)
    case .timer:
        // ACK_INTERVAL_MS ごとに、受信済みの位置を ack として返す。
        // 呼び出し側が周期を管理する（コアは時刻を持たない）。
        let commands = state.received.map { mark in
            WhesoReceiverCommand.ack(
                senderId: mark.senderId,
                channel: mark.channel,
                spatialId: mark.spatialId,
                highestSeq: mark.highestSeq
            )
        }
        return WhesoReceiverStepResult(state: state, commands: commands)
    }
}

private func findStream(_ state: WhesoReceiverState, _ senderId: Int64, _ channel: Int64) -> WhesoStreamState? {
    state.streams.first(where: { $0.senderId == senderId && $0.channel == channel })
}

/// spatialId の範囲は最低品質から最高品質までである。
private func clampSpatial(_ value: Int64) -> Int64 {
    if value < WhesoConstants.V_360P15_SPATIAL_ID {
        return WhesoConstants.V_360P15_SPATIAL_ID
    }
    if value > WhesoConstants.V_4K60_SPATIAL_ID {
        return WhesoConstants.V_4K60_SPATIAL_ID
    }
    return value
}

/// 購読一覧の適用。表 1 行目と 2 行目に対応する。
private func handleSubscribeList(
    _ state: WhesoReceiverState,
    _ entries: [WhesoSubscribeEntry]
) -> WhesoReceiverStepResult {
    var commands: [WhesoReceiverCommand] = []
    var kept: [WhesoStreamState] = []

    let sorted = entries.sorted { ($0.senderId, $0.channel) < ($1.senderId, $1.channel) }
    for entry in sorted {
        let existing = findStream(state, entry.senderId, entry.channel)
        let unsubscribed = existing == nil || existing?.phase == .unsubscribed
        if unsubscribed {
            commands.append(.subscribeChange(
                to: entry.senderId,
                channel: entry.channel,
                want: true,
                maxSpatialId: entry.maxSpatialId,
                maxTemporalId: entry.maxTemporalId
            ))
            commands.append(.keyframeRequest(
                targetId: entry.senderId,
                channel: entry.channel,
                spatialId: entry.maxSpatialId
            ))
            kept.append(WhesoStreamState(
                senderId: entry.senderId,
                channel: entry.channel,
                phase: .subscribed,
                spatialId: entry.maxSpatialId,
                temporalId: entry.maxTemporalId,
                displayWidth: existing?.displayWidth ?? 0
            ))
            continue
        }
        if var stream = existing {
            stream.phase = .subscribed
            kept.append(stream)
        }
    }

    // 一覧から外れたものは購読解除する（表 2 行目）。
    for stream in state.streams {
        let stillWanted = entries.contains {
            $0.senderId == stream.senderId && $0.channel == stream.channel
        }
        if !stillWanted && stream.phase != .unsubscribed {
            commands.append(.subscribeChange(
                to: stream.senderId,
                channel: stream.channel,
                want: false,
                maxSpatialId: 0,
                maxTemporalId: 0
            ))
        }
    }

    var next = state
    next.streams = kept.sorted { ($0.senderId, $0.channel) < ($1.senderId, $1.channel) }
    let after = reallocate(next)
    return WhesoReceiverStepResult(state: after.state, commands: commands + after.commands)
}

/// 送信者の退出。表 6 行目に対応する。
private func handleLeave(_ state: WhesoReceiverState, _ id: Int64) -> WhesoReceiverStepResult {
    let streams = state.streams.filter { $0.senderId != id }
    if streams.count == state.streams.count {
        return WhesoReceiverStepResult(state: state, commands: [])
    }
    var next = state
    next.streams = streams
    // 退出者の受信位置も除去する。残すと居ない相手へ ack を返し続ける。
    next.received = state.received.filter { $0.senderId != id }
    return reallocate(next)
}

/// 表示・非表示。表 7 行目と 8 行目に対応する。
private func handleVisibility(_ state: WhesoReceiverState, _ visible: Bool) -> WhesoReceiverStepResult {
    if visible == state.visible {
        return WhesoReceiverStepResult(state: state, commands: [])
    }
    var commands: [WhesoReceiverCommand] = []
    var streams: [WhesoStreamState] = []
    for stream in state.streams {
        if !visible && stream.phase == .subscribed {
            // 非表示では購読を解除するが、状態は保持する（PAUSED）。
            commands.append(.subscribeChange(
                to: stream.senderId,
                channel: stream.channel,
                want: false,
                maxSpatialId: 0,
                maxTemporalId: 0
            ))
            var paused = stream
            paused.phase = .paused
            streams.append(paused)
            continue
        }
        if visible && stream.phase == .paused {
            commands.append(.subscribeChange(
                to: stream.senderId,
                channel: stream.channel,
                want: true,
                maxSpatialId: stream.spatialId,
                maxTemporalId: stream.temporalId
            ))
            commands.append(.keyframeRequest(
                targetId: stream.senderId,
                channel: stream.channel,
                spatialId: stream.spatialId
            ))
            var resumed = stream
            resumed.phase = .subscribed
            streams.append(resumed)
            continue
        }
        streams.append(stream)
    }
    var next = state
    next.visible = visible
    next.streams = streams
    return WhesoReceiverStepResult(state: next, commands: commands)
}

/// 表示寸法の申告。未申告の相手は最低品質に留める（ADR-0015）。
private func handleDisplaySize(
    _ state: WhesoReceiverState,
    senderId: Int64,
    channel: Int64,
    width: Int64
) -> WhesoReceiverStepResult {
    if findStream(state, senderId, channel) == nil {
        var next = state
        next.unexpectedEvents.append("displaySize")
        return WhesoReceiverStepResult(state: next, commands: [])
    }
    var next = state
    next.streams = state.streams.map { stream in
        if stream.senderId == senderId && stream.channel == channel {
            var updated = stream
            updated.displayWidth = width
            return updated
        }
        return stream
    }
    return reallocate(next)
}

/// 測定報告。勾配が劣化閾値を超えたら tier を 1 段下げ、回復閾値を下回ったら 1 段上げる。
/// 測定報告。規範は 2 つの層を定めている。
///
/// 1. 状態機械（state-machines 3 節）: 勾配が閾値を超えたら tier を 1 段下げる
/// 2. 輻輳制御（congestion 4.2 の AIMD）: target を劣化時に 0.85 倍し、回復が 3 回
///    連続したら RATE_PROBE_BPS を加える（上限を超えない）
///
/// 0.85 は浮動小数点で計算しない。target * 17 / 20 の整数演算とし切り捨てる。
private func handleReport(
    _ state: WhesoReceiverState,
    _ delayUs: [Int64],
    _ t: Int64
) -> WhesoReceiverStepResult {
    let trend = whesoDelaySlope(delayUs)
    let degrading = trend.numerator * WhesoConstants.SHARD_TREND_ENTER_T2_DEN
        > WhesoConstants.SHARD_TREND_ENTER_T2_NUM * trend.denominator
    let recovering = trend.numerator * WhesoConstants.SHARD_TREND_EXIT_DEN
        < WhesoConstants.SHARD_TREND_EXIT_NUM * trend.denominator

    // --- AIMD。target を更新する ---
    var target = state.targetBytesPerSec
    var holdUntil = state.rateHoldUntilMs
    var streak = state.recoverStreak
    if degrading {
        streak = 0
        // 待ちの間は減らさない。1 回の揺れで連続して落とさないためである。
        if t >= state.rateHoldUntilMs {
            if case .success(let value) = whesoTruncDiv(target * 17, 20) {
                target = value
            }
            holdUntil = t + WhesoConstants.RATE_HOLD_MS
        }
    } else if recovering {
        streak = state.recoverStreak + 1
        if streak >= WhesoConstants.RATE_RECOVER_STREAK {
            var increment: Int64 = 0
            if case .success(let value) = whesoTruncDiv(WhesoConstants.RATE_PROBE_BPS, 8) {
                increment = value
            }
            let raised = target + increment
            target = raised > state.targetCeilingBytesPerSec ? state.targetCeilingBytesPerSec : raised
            streak = 0
        }
    } else {
        streak = 0
    }

    if !degrading && !recovering {
        var next = state
        next.trend = trend
        next.targetBytesPerSec = target
        next.rateHoldUntilMs = holdUntil
        next.recoverStreak = streak
        return WhesoReceiverStepResult(state: next, commands: [])
    }
    let delta: Int64 = degrading ? -1 : 1
    var commands: [WhesoReceiverCommand] = []
    var streams: [WhesoStreamState] = []
    for stream in state.streams {
        if stream.phase != .subscribed {
            streams.append(stream)
            continue
        }
        let nextSpatial = clampSpatial(stream.spatialId + delta)
        if nextSpatial == stream.spatialId {
            streams.append(stream)
            continue
        }
        var updated = stream
        updated.spatialId = nextSpatial
        streams.append(updated)
        commands.append(.setTier(targetId: stream.senderId, channel: stream.channel, tier: nextSpatial))
        // spatialId が変わる場合のみキーフレームを要求する（表 4 行目と 3 行目の違い）。
        if nextSpatial > stream.spatialId {
            commands.append(.keyframeRequest(
                targetId: stream.senderId,
                channel: stream.channel,
                spatialId: nextSpatial
            ))
        }
    }
    var next = state
    next.trend = trend
    next.streams = streams
    next.targetBytesPerSec = target
    next.rateHoldUntilMs = holdUntil
    next.recoverStreak = streak
    return WhesoReceiverStepResult(state: next, commands: commands)
}

/// メディアの転送。要求 tier を超えるユニットは転送しない。
private func handleMedia(
    _ state: WhesoReceiverState,
    from: Int64,
    ch: Int64,
    sid: Int64,
    tid: Int64,
    seq: Int64
) -> WhesoReceiverStepResult {
    guard let stream = findStream(state, from, ch), stream.phase == .subscribed else {
        return WhesoReceiverStepResult(state: state, commands: [])
    }
    if sid > stream.spatialId || tid > stream.temporalId {
        return WhesoReceiverStepResult(state: state, commands: [.drop(priority: 1, count: 1)])
    }
    // 受信した位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
    return WhesoReceiverStepResult(
        state: markReceived(state, from: from, ch: ch, sid: sid, seq: seq),
        commands: [.forward(to: [whesoReceiverSelfId])]
    )
}

/// 受信した位置を更新する。後戻りする値では更新しない。
private func markReceived(
    _ state: WhesoReceiverState,
    from: Int64,
    ch: Int64,
    sid: Int64,
    seq: Int64
) -> WhesoReceiverState {
    if seq <= 0 {
        return state
    }
    let existing = state.received.first(where: {
        $0.senderId == from && $0.channel == ch && $0.spatialId == sid
    })
    if let mark = existing, mark.highestSeq >= seq {
        return state
    }
    var next = state
    next.received = (state.received.filter {
        !($0.senderId == from && $0.channel == ch && $0.spatialId == sid)
    } + [WhesoReceivedMark(senderId: from, channel: ch, spatialId: sid, highestSeq: seq)])
        .sorted { ($0.senderId, $0.channel, $0.spatialId) < ($1.senderId, $1.channel, $1.spatialId) }
    return next
}

/// 発話者を先に、次に senderId の昇順で並べる。順序は決定的でなければならない。
private func priorityKey(_ state: WhesoReceiverState, _ stream: WhesoStreamState) -> (Int64, Int64, Int64) {
    let speaker: Int64 = state.activeSpeakerId == stream.senderId ? 0 : 1
    return (speaker, stream.senderId, stream.channel)
}

/**
 帯域予算から tier を配分する（congestion.md 4.3）。
 除算は整数で行い、切り捨てる。浮動小数点を使わない（ADR-0017）。
 */
private func reallocate(_ state: WhesoReceiverState) -> WhesoReceiverStepResult {
    var commands: [WhesoReceiverCommand] = []
    let budgetOutcome = whesoTruncDiv(state.targetBytesPerSec * 8 * 9, 10)
    let budgetBps: Int64
    switch budgetOutcome {
    case .success(let value):
        budgetBps = value
    case .failure:
        budgetBps = 0
    }
    let highOutcome = whesoTruncDiv(budgetBps, WhesoConstants.V_4K60_TARGET_BITRATE)
    let highQualityCount: Int64
    switch highOutcome {
    case .success(let value):
        highQualityCount = value
    case .failure:
        highQualityCount = 0
    }
    let thumbnailCost = WhesoConstants.V_360P15_TARGET_BITRATE

    let ordered = state.streams
        .filter { $0.phase == .subscribed }
        .sorted { priorityKey(state, $0) < priorityKey(state, $1) }

    var streams: [WhesoStreamState] = []
    var assignedHigh: Int64 = 0
    var remaining = budgetBps
    var degraded = false

    for stream in state.streams {
        if stream.phase != .subscribed {
            streams.append(stream)
            continue
        }
        let rankIndex = ordered.firstIndex(where: {
            $0.senderId == stream.senderId && $0.channel == stream.channel
        })
        let rank: Int64 = rankIndex.map { Int64($0) } ?? -1
        let nextSpatial: Int64
        if stream.displayWidth == 0 {
            // 表示寸法の申告が無い相手は最低品質に留める（ADR-0015）。
            nextSpatial = WhesoConstants.DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID
        } else if assignedHigh < highQualityCount && rank < highQualityCount {
            nextSpatial = WhesoConstants.V_4K60_SPATIAL_ID
            assignedHigh += 1
            remaining -= WhesoConstants.V_4K60_TARGET_BITRATE
        } else if remaining >= thumbnailCost {
            nextSpatial = WhesoConstants.V_360P15_SPATIAL_ID
            remaining -= thumbnailCost
        } else {
            // 予算が尽きた。発話者のサムネイルのみを維持する（最低保証）。
            nextSpatial = WhesoConstants.V_360P15_SPATIAL_ID
            degraded = true
        }
        if nextSpatial != stream.spatialId {
            commands.append(.setTier(targetId: stream.senderId, channel: stream.channel, tier: nextSpatial))
            if nextSpatial > stream.spatialId {
                // spatialId が上がる場合はエンコーダ出力が切り替わるためキーフレームが必要である。
                commands.append(.keyframeRequest(
                    targetId: stream.senderId,
                    channel: stream.channel,
                    spatialId: nextSpatial
                ))
            }
        }
        var updated = stream
        updated.spatialId = nextSpatial
        streams.append(updated)
    }

    if degraded && !state.degraded {
        // 最低保証（発話者のサムネイル 1 本と全員の音声）を下回った。利用側へ警告する。
        commands.append(.notify(code: degradedWarning))
    }

    var next = state
    next.streams = streams.sorted { ($0.senderId, $0.channel) < ($1.senderId, $1.channel) }
    next.degraded = degraded
    return WhesoReceiverStepResult(state: next, commands: commands)
}
