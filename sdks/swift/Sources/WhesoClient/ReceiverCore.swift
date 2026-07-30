// 受信ノード（receiver）の判断コア（Swift）。
//
// 規範: state-machines.md 2 節（購読と tier）、congestion.md 4.1・4.2・4.3、
//       conformance.md 4 節、ADR-0027（はしごの利用）、ADR-0029（狭帯域では音声を守る）。
// TypeScript の参照実装（packages/core/src/receiver-core.ts）と**同一の出力**を返さなければ
// ならない。照合は凍結トレース（spec/vectors/trace-receiver.jsonl）で行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻・乱数・浮動小数点・入出力に触れない。除算は整数の切り捨てのみを使う。
// Foundation に依存しない（コアは標準ライブラリのみで成立させる）。

/// 品質低下の警告。文言は利用側が国際化キーから作る（sdk-api.md 6 節）。
private let degradedWarning = "W_DEGRADED"

/// 受信者自身の識別子。転送先は常にこの 1 人である。
public let whesoReceiverSelfId: Int64 = 0

/// (senderId, channel) ごとの購読状態（state-machines.md 2 節）。
/// AUDIO_ONLY は ADR-0029 で追加した。映像の購読を落として音声だけを維持する状態。
public enum WhesoStreamPhase: String, Equatable {
    case unsubscribed = "UNSUBSCRIBED"
    case subscribed = "SUBSCRIBED"
    case paused = "PAUSED"
    case audioOnly = "AUDIO_ONLY"
}

/// 1 本のストリームの状態。
public struct WhesoStreamState: Equatable {
    public var senderId: Int64
    public var channel: Int64
    public var phase: WhesoStreamPhase
    /// 現在要求している段番号（ADR-0026）。
    public var spatialId: Int64
    /// 現在要求している最大 temporalId。
    public var temporalId: Int64
    /// 利用側が申告した表示寸法（論理画素）。未申告は 0。
    public var displayWidth: Int64
}

/// カタログの 1 段。streamCatalog から取り込む（ADR-0027 の 1）。
public struct WhesoCatalogRung: Equatable {
    public let sid: Int64
    public let width: Int64
    public let height: Int64
    public let framerate: Int64
    public let temporalLayers: Int64
    public let targetBitrate: Int64
}

/// 送信者 1 人・1 チャネルのはしご。
public struct WhesoCatalogLadder: Equatable {
    public let senderId: Int64
    public let channel: Int64
    /// sid の昇順で保持する。
    public let rungs: [WhesoCatalogRung]
}

/// 受信済みの位置。ack の内容になる。
public struct WhesoReceivedMark: Equatable {
    public let senderId: Int64
    public let channel: Int64
    public let spatialId: Int64
    public let highestSeq: Int64
}

public struct WhesoReceiverState: Equatable {
    /// senderId, channel の昇順で保持する。
    public var streams: [WhesoStreamState]
    /// 会議全体のはしご。senderId, channel の昇順で保持する。
    public var catalog: [WhesoCatalogLadder]
    public var visible: Bool
    /// 下り帯域の目標値（bytes/sec）。
    public var targetBytesPerSec: Int64
    /// 発話中の送信者。最低保証の対象。
    public var activeSpeakerId: Int64?
    /// 直近の遅延勾配。
    public var trend: WhesoSlope
    /// 品質が最低保証を下回っているか。
    public var degraded: Bool
    /// 音声だけの状態か（ADR-0029）。
    public var audioOnly: Bool
    /// 次に減少の判定を行える時刻（AIMD。congestion 4.2）。
    public var rateHoldUntilMs: Int64
    /// 回復判定が連続した回数。
    public var recoverStreak: Int64
    /// 目標ビットレートの上限（bytes/sec）。観測した goodput の最大値。
    public var targetCeilingBytesPerSec: Int64
    /// 表に無いイベントの記録。
    public var unexpectedEvents: [String]
    /// (senderId, channel, spatialId) ごとに受信した最大の sequenceNumber。
    public var received: [WhesoReceivedMark]
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
    /// 観測した goodput。**目標を下げない**（congestion.md 4.1）。
    case goodput(bytesPerSec: Int64)
    case activeSpeaker(id: Int64?)
    case catalog(entries: [WhesoCatalogLadder])
    case displaySize(senderId: Int64, channel: Int64, width: Int64)
    case report(delayUs: [Int64])
    case media(from: Int64, ch: Int64, sid: Int64, tid: Int64, seq: Int64)
    /// 購読者からのキーフレーム要求（ADR-0039）。状態は変えない。
    case keyframeRequest(senderId: Int64, channel: Int64, spatialId: Int64)
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

// MARK: - 初期状態

/// 初期状態。目標は最低から始める。引数を取らない（ADR-0028）。
public func whesoInitialReceiverState() -> WhesoReceiverState {
    let floorResult = whesoTruncDiv(WhesoConstants.MIN_VIABLE_BPS, 8)
    let floor: Int64
    switch floorResult {
    case .success(let value):
        floor = value
    case .failure:
        floor = 0
    }
    return WhesoReceiverState(
        streams: [],
        catalog: [],
        visible: true,
        targetBytesPerSec: floor,
        activeSpeakerId: nil,
        trend: WhesoSlope(numerator: 0, denominator: 1),
        degraded: false,
        audioOnly: false,
        rateHoldUntilMs: 0,
        recoverStreak: 0,
        targetCeilingBytesPerSec: floor,
        unexpectedEvents: [],
        received: []
    )
}

// MARK: - ステップ関数

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
        return handleBudget(state, bytesPerSec)
    case .goodput(let bytesPerSec):
        return handleGoodput(state, bytesPerSec)
    case .activeSpeaker(let id):
        var next = state
        next.activeSpeakerId = id
        return reallocate(next)
    case .catalog(let entries):
        return handleCatalog(state, entries)
    case .displaySize(let senderId, let channel, let width):
        return handleDisplaySize(state, senderId: senderId, channel: channel, width: width)
    case .report(let delayUs):
        return handleReport(state, delayUs, t)
    case .media(let from, let ch, let sid, let tid, let seq):
        return handleMedia(state, from: from, ch: ch, sid: sid, tid: tid, seq: seq)
    case .keyframeRequest(let senderId, let channel, let spatialId):
        // 判断は無い。要求をコマンドへ直すだけである（間隔制限は実行側）。
        return WhesoReceiverStepResult(
            state: state,
            commands: [.keyframeRequest(targetId: senderId, channel: channel, spatialId: spatialId)]
        )
    case .timer:
        // ACK_INTERVAL_MS ごとに、受信済みの位置を ack として返す。
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

// MARK: - 音声チャネル判定

private func isReceiverAudio(_ channel: Int64) -> Bool {
    channel == Int64(WhesoWireLayout.CHANNEL_AUDIO) || channel == Int64(WhesoWireLayout.CHANNEL_SCREEN_AUDIO)
}

// MARK: - はしごの参照

private func ladderOf(_ state: WhesoReceiverState, _ senderId: Int64, _ channel: Int64) -> [WhesoCatalogRung] {
    guard let entry = state.catalog.first(where: { $0.senderId == senderId && $0.channel == channel }) else {
        return []
    }
    return entry.rungs
}

/// 表示寸法から要求すべき段の上限を返す。
/// 規則: 表示幅以上の幅を持つ最小の段。無ければ最上段。未申告は最下段。
private func rungCapFor(_ state: WhesoReceiverState, _ stream: WhesoStreamState) -> Int64 {
    let rungs = ladderOf(state, stream.senderId, stream.channel)
    if rungs.isEmpty {
        return 0
    }
    var lowest = rungs[0].sid
    var top = rungs[0].sid
    for rung in rungs {
        if rung.sid < lowest { lowest = rung.sid }
        if rung.sid > top { top = rung.sid }
    }
    if stream.displayWidth <= 0 {
        return lowest
    }
    var bestSid: Int64 = -1
    var bestWidth: Int64 = Int64.max
    for rung in rungs {
        if rung.width < stream.displayWidth {
            continue
        }
        if rung.width < bestWidth {
            bestWidth = rung.width
            bestSid = rung.sid
        }
    }
    return bestSid < 0 ? top : bestSid
}

/// 段の費用（bits/sec）。申告が無ければ 0。
private func costOf(_ state: WhesoReceiverState, _ stream: WhesoStreamState, _ sid: Int64) -> Int64 {
    for rung in ladderOf(state, stream.senderId, stream.channel) {
        if rung.sid == sid {
            return rung.targetBitrate
        }
    }
    return 0
}

/// はしごの最下段。カタログが無ければ 0。
private func lowestRung(_ state: WhesoReceiverState, _ stream: WhesoStreamState) -> Int64 {
    let rungs = ladderOf(state, stream.senderId, stream.channel)
    var lowest: Int64 = -1
    for rung in rungs {
        if lowest < 0 || rung.sid < lowest {
            lowest = rung.sid
        }
    }
    return lowest < 0 ? 0 : lowest
}

/// はしごの最上段。カタログが無ければ 0。
private func highestRung(_ state: WhesoReceiverState, _ stream: WhesoStreamState) -> Int64 {
    let rungs = ladderOf(state, stream.senderId, stream.channel)
    var top: Int64 = -1
    for rung in rungs {
        if rung.sid > top {
            top = rung.sid
        }
    }
    return top < 0 ? 0 : top
}

// MARK: - budget と catalog

/// 下り帯域の観測。天井を押し上げるだけに使う（congestion.md 4.1）。
/// 観測した goodput。天井を押し上げ、目標を上げる方向にだけ使う（congestion.md 4.1）。
private func handleGoodput(_ state: WhesoReceiverState, _ bytesPerSec: Int64) -> WhesoReceiverStepResult {
    if bytesPerSec <= 0 {
        return WhesoReceiverStepResult(state: state, commands: [])
    }
    let ceiling = bytesPerSec > state.targetCeilingBytesPerSec ? bytesPerSec : state.targetCeilingBytesPerSec
    let raised = bytesPerSec > state.targetBytesPerSec ? bytesPerSec : state.targetBytesPerSec
    let target = raised > ceiling ? ceiling : raised
    if target == state.targetBytesPerSec && ceiling == state.targetCeilingBytesPerSec {
        return WhesoReceiverStepResult(state: state, commands: [])
    }
    var next = state
    next.targetBytesPerSec = target
    next.targetCeilingBytesPerSec = ceiling
    return reallocate(next)
}

private func handleBudget(_ state: WhesoReceiverState, _ bytesPerSec: Int64) -> WhesoReceiverStepResult {
    let ceiling = bytesPerSec > state.targetCeilingBytesPerSec ? bytesPerSec : state.targetCeilingBytesPerSec
    var next = state
    next.targetBytesPerSec = bytesPerSec
    next.targetCeilingBytesPerSec = ceiling
    return reallocate(next)
}

private func handleCatalog(_ state: WhesoReceiverState, _ entries: [WhesoCatalogLadder]) -> WhesoReceiverStepResult {
    let normalized = entries.map { entry in
        WhesoCatalogLadder(
            senderId: entry.senderId,
            channel: entry.channel,
            rungs: entry.rungs.sorted { $0.sid < $1.sid }
        )
    }.sorted { ($0.senderId, $0.channel) < ($1.senderId, $1.channel) }
    var next = state
    next.catalog = normalized
    return reallocate(next)
}

// MARK: - 購読

private func findStream(_ state: WhesoReceiverState, _ senderId: Int64, _ channel: Int64) -> WhesoStreamState? {
    state.streams.first(where: { $0.senderId == senderId && $0.channel == channel })
}

private func streamOrder(_ a: WhesoStreamState, _ b: WhesoStreamState) -> Bool {
    a.senderId != b.senderId ? a.senderId < b.senderId : a.channel < b.channel
}

private func entryOrder(_ a: WhesoSubscribeEntry, _ b: WhesoSubscribeEntry) -> Bool {
    a.senderId != b.senderId ? a.senderId < b.senderId : a.channel < b.channel
}

/// 購読一覧の適用。新規購読は最下段から始める。
private func handleSubscribeList(
    _ state: WhesoReceiverState,
    _ entries: [WhesoSubscribeEntry]
) -> WhesoReceiverStepResult {
    var commands: [WhesoReceiverCommand] = []
    var kept: [WhesoStreamState] = []

    let sorted = entries.sorted(by: entryOrder)
    for entry in sorted {
        let existing = findStream(state, entry.senderId, entry.channel)
        let unsubscribed = existing == nil || existing?.phase == .unsubscribed
        if unsubscribed {
            // 最下段から始める（congestion.md 6 節、ADR-0028）。
            let dummyStream = WhesoStreamState(
                senderId: entry.senderId, channel: entry.channel,
                phase: .subscribed, spatialId: 0, temporalId: 0, displayWidth: 0
            )
            let start: Int64 = isReceiverAudio(entry.channel) ? 0 : lowestRung(state, dummyStream)
            commands.append(.subscribeChange(
                to: entry.senderId, channel: entry.channel,
                want: true, maxSpatialId: start, maxTemporalId: entry.maxTemporalId
            ))
            commands.append(.keyframeRequest(
                targetId: entry.senderId, channel: entry.channel, spatialId: start
            ))
            kept.append(WhesoStreamState(
                senderId: entry.senderId, channel: entry.channel,
                phase: .subscribed, spatialId: start,
                temporalId: entry.maxTemporalId,
                displayWidth: existing?.displayWidth ?? 0
            ))
            continue
        }
        if let stream = existing {
            var updated = stream
            updated.phase = .subscribed
            kept.append(updated)
        }
    }

    // 一覧から外れたものは購読解除する。
    for stream in state.streams {
        let stillWanted = entries.contains {
            $0.senderId == stream.senderId && $0.channel == stream.channel
        }
        if !stillWanted && stream.phase != .unsubscribed {
            commands.append(.subscribeChange(
                to: stream.senderId, channel: stream.channel,
                want: false, maxSpatialId: 0, maxTemporalId: 0
            ))
        }
    }

    var next = state
    next.streams = kept.sorted(by: streamOrder)
    let after = reallocate(next)
    return WhesoReceiverStepResult(state: after.state, commands: commands + after.commands)
}

/// 送信者の退出。カタログも除去する。
private func handleLeave(_ state: WhesoReceiverState, _ id: Int64) -> WhesoReceiverStepResult {
    let streams = state.streams.filter { $0.senderId != id }
    if streams.count == state.streams.count {
        return WhesoReceiverStepResult(state: state, commands: [])
    }
    var next = state
    next.streams = streams
    next.received = state.received.filter { $0.senderId != id }
    next.catalog = state.catalog.filter { $0.senderId != id }
    return reallocate(next)
}

/// 表示・非表示。
private func handleVisibility(_ state: WhesoReceiverState, _ visible: Bool) -> WhesoReceiverStepResult {
    if visible == state.visible {
        return WhesoReceiverStepResult(state: state, commands: [])
    }
    var commands: [WhesoReceiverCommand] = []
    var streams: [WhesoStreamState] = []
    for stream in state.streams {
        if !visible && stream.phase == .subscribed {
            commands.append(.subscribeChange(
                to: stream.senderId, channel: stream.channel,
                want: false, maxSpatialId: 0, maxTemporalId: 0
            ))
            var paused = stream
            paused.phase = .paused
            streams.append(paused)
            continue
        }
        if visible && stream.phase == .paused {
            commands.append(.subscribeChange(
                to: stream.senderId, channel: stream.channel,
                want: true, maxSpatialId: stream.spatialId, maxTemporalId: stream.temporalId
            ))
            commands.append(.keyframeRequest(
                targetId: stream.senderId, channel: stream.channel, spatialId: stream.spatialId
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

/// 表示寸法の申告。
private func handleDisplaySize(
    _ state: WhesoReceiverState,
    senderId: Int64, channel: Int64, width: Int64
) -> WhesoReceiverStepResult {
    if findStream(state, senderId, channel) == nil {
        var next = state
        next.unexpectedEvents = appendUnexpected(next.unexpectedEvents, "displaySize")
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

// MARK: - 報告と AIMD

/// 遅延の報告。tier を 1 段動かし、target を AIMD で更新する。
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

    // --- AIMD ---
    var target = state.targetBytesPerSec
    var holdUntil = state.rateHoldUntilMs
    var streak = state.recoverStreak
    if degrading {
        streak = 0
        if t >= state.rateHoldUntilMs {
            let lowered: Int64
            if case .success(let value) = whesoTruncDiv(target * 17, 20) {
                lowered = value
            } else {
                lowered = target
            }
            // 予兆で最低成立点を割らない（ADR-0040）
            let floor: Int64
            if case .success(let value) = whesoTruncDiv(WhesoConstants.MIN_VIABLE_BPS, 8) {
                floor = value
            } else {
                floor = 0
            }
            target = lowered < floor ? floor : lowered
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
        // 増減の条件を満たさない。連続回数を切る。
        streak = 0
    }

    var afterRate = state
    afterRate.trend = trend
    afterRate.targetBytesPerSec = target
    afterRate.rateHoldUntilMs = holdUntil
    afterRate.recoverStreak = streak

    if !degrading && !recovering {
        return WhesoReceiverStepResult(state: afterRate, commands: [])
    }

    // --- 状態機械。tier を 1 段動かす ---
    let delta: Int64 = degrading ? -1 : 1
    var commands: [WhesoReceiverCommand] = []
    var streams: [WhesoStreamState] = []
    for stream in afterRate.streams {
        if stream.phase != .subscribed || isReceiverAudio(stream.channel) {
            // 音声には段が無い。
            streams.append(stream)
            continue
        }
        let floor = lowestRung(afterRate, stream)
        let cap = rungCapFor(afterRate, stream)
        let raw = stream.spatialId + delta
        let nextSpatial: Int64
        if raw < floor { nextSpatial = floor }
        else if raw > cap { nextSpatial = cap }
        else { nextSpatial = raw }
        if nextSpatial == stream.spatialId {
            streams.append(stream)
            continue
        }
        var updated = stream
        updated.spatialId = nextSpatial
        streams.append(updated)
        commands.append(.setTier(targetId: stream.senderId, channel: stream.channel, tier: nextSpatial))
        // 段が変わればキーフレームが必要（simulcast の別ストリームへ切り替わる）。
        commands.append(.keyframeRequest(
            targetId: stream.senderId, channel: stream.channel, spatialId: nextSpatial
        ))
    }
    afterRate.streams = streams
    return WhesoReceiverStepResult(state: afterRate, commands: commands)
}

// MARK: - メディア

/// メディアの転送。要求 tier を超えるユニットは転送しない。
private func handleMedia(
    _ state: WhesoReceiverState,
    from: Int64, ch: Int64, sid: Int64, tid: Int64, seq: Int64
) -> WhesoReceiverStepResult {
    guard let stream = findStream(state, from, ch), stream.phase == .subscribed else {
        return WhesoReceiverStepResult(state: state, commands: [])
    }
    if sid > stream.spatialId || tid > stream.temporalId {
        return WhesoReceiverStepResult(state: state, commands: [.drop(priority: 1, count: 1)])
    }
    return WhesoReceiverStepResult(
        state: markReceived(state, from: from, ch: ch, sid: sid, seq: seq),
        commands: [.forward(to: [whesoReceiverSelfId])]
    )
}

/// 受信した位置を更新する。後戻りする値では更新しない。
private func markReceived(
    _ state: WhesoReceiverState,
    from: Int64, ch: Int64, sid: Int64, seq: Int64
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

// MARK: - 段の配分（reallocate）

/// 発話者を先に、音声最優先、次に senderId の昇順。
private func priorityOrder(
    _ state: WhesoReceiverState,
    _ a: WhesoStreamState,
    _ b: WhesoStreamState
) -> Bool {
    let aAudio: Int64 = isReceiverAudio(a.channel) ? 0 : 1
    let bAudio: Int64 = isReceiverAudio(b.channel) ? 0 : 1
    if aAudio != bAudio { return aAudio < bAudio }
    let aSpeaker: Int64 = state.activeSpeakerId == a.senderId ? 0 : 1
    let bSpeaker: Int64 = state.activeSpeakerId == b.senderId ? 0 : 1
    if aSpeaker != bSpeaker { return aSpeaker < bSpeaker }
    if a.senderId != b.senderId { return a.senderId < b.senderId }
    return a.channel < b.channel
}

private func streamKey(_ stream: WhesoStreamState) -> String {
    "\(stream.senderId):\(stream.channel)"
}

/// 帯域予算から段を配分する（congestion.md 4.3、ADR-0027、ADR-0029）。
private func reallocate(_ state: WhesoReceiverState) -> WhesoReceiverStepResult {
    var commands: [WhesoReceiverCommand] = []
    // 回線の速度（bits/sec）。
    let linkBps = state.targetBytesPerSec * 8
    // 段を買うための予算。ヘッダと制御の余裕を 10% 取る。
    let budgetResult = whesoTruncDiv(linkBps * 9, 10)
    let budgetBps: Int64
    switch budgetResult {
    case .success(let value): budgetBps = value
    case .failure: budgetBps = 0
    }

    // --- 音声だけの状態への出入り（ヒステリシス。ADR-0029 の 1）---
    // 判定は回線の速度そのもので行う。10% を引いた予算で判定してはならない。
    let nextAudioOnly: Bool
    if state.audioOnly {
        nextAudioOnly = linkBps < WhesoConstants.AUDIO_ONLY_EXIT_BPS
    } else {
        nextAudioOnly = linkBps < WhesoConstants.AUDIO_ONLY_ENTER_BPS
    }

    if nextAudioOnly {
        var streams: [WhesoStreamState] = []
        for stream in state.streams {
            if isReceiverAudio(stream.channel) {
                // 音声は維持する。
                streams.append(stream)
                continue
            }
            if stream.phase == .subscribed {
                commands.append(.subscribeChange(
                    to: stream.senderId, channel: stream.channel,
                    want: false, maxSpatialId: 0, maxTemporalId: 0
                ))
                var ao = stream
                ao.phase = .audioOnly
                streams.append(ao)
                continue
            }
            streams.append(stream)
        }
        if !state.degraded {
            commands.append(.notify(code: degradedWarning))
        }
        var next = state
        next.streams = streams.sorted(by: streamOrder)
        next.audioOnly = true
        next.degraded = true
        return WhesoReceiverStepResult(state: next, commands: commands)
    }

    // --- AUDIO_ONLY から復帰する ---
    var revived: [WhesoStreamState] = []
    for stream in state.streams {
        if stream.phase == .audioOnly {
            let floor = lowestRung(state, stream)
            var resumed = stream
            resumed.phase = .subscribed
            resumed.spatialId = floor
            revived.append(resumed)
            commands.append(.subscribeChange(
                to: stream.senderId, channel: stream.channel,
                want: true, maxSpatialId: floor, maxTemporalId: stream.temporalId
            ))
            commands.append(.keyframeRequest(
                targetId: stream.senderId, channel: stream.channel, spatialId: floor
            ))
            continue
        }
        revived.append(stream)
    }
    var base = state
    base.streams = revived
    base.audioOnly = false

    // --- 予算で段を買う ---
    let ordered = base.streams
        .filter { $0.phase == .subscribed }
        .sorted { priorityOrder(base, $0, $1) }

    var assigned: [String: Int64] = [:]
    var remaining = budgetBps
    var degraded = false

    for stream in ordered {
        if isReceiverAudio(stream.channel) {
            // 音声の費用を引くが段の選択は行わない。
            remaining -= costOf(base, stream, 0)
            continue
        }
        let floor = lowestRung(base, stream)
        let cap = rungCapFor(base, stream)
        var chosen = floor
        // 上限から下へ降りて、予算に収まる最も高い段を選ぶ。
        var sid = cap
        while sid >= floor {
            let cost = costOf(base, stream, sid)
            if cost <= remaining {
                chosen = sid
                break
            }
            sid -= 1
        }
        let chosenCost = costOf(base, stream, chosen)
        if chosenCost > remaining {
            // 最下段さえ入らない。最低保証として維持し警告する。
            degraded = true
        }
        remaining -= chosenCost
        assigned[streamKey(stream)] = chosen
    }

    var streams: [WhesoStreamState] = []
    for stream in base.streams {
        guard let next = assigned[streamKey(stream)] else {
            streams.append(stream)
            continue
        }
        if next == stream.spatialId {
            streams.append(stream)
            continue
        }
        commands.append(.setTier(targetId: stream.senderId, channel: stream.channel, tier: next))
        commands.append(.keyframeRequest(
            targetId: stream.senderId, channel: stream.channel, spatialId: next
        ))
        var updated = stream
        updated.spatialId = next
        streams.append(updated)
    }

    if degraded && !base.degraded {
        commands.append(.notify(code: degradedWarning))
    }

    base.streams = streams.sorted(by: streamOrder)
    base.degraded = degraded
    return WhesoReceiverStepResult(state: base, commands: commands)
}

