// 中継ノード（shard）の判断コア（Swift）。
//
// TypeScript の参照実装（packages/core/src/shard-core.ts）と**同じ入力列から同じ出力列**を
// 返さなければならない（conformance.md 2 節の層 2）。照合は凍結トレースで行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻は入力として受け取り、内部で取得しない。
// 浮動小数点を使わない。例外を投げない。反復順序は決定的にする。
// Foundation に依存しない（コアは標準ライブラリのみで成立させる）。

// MARK: - 輻輳状態（state-machines.md 3 節）

public enum WhesoCongestion: String, Equatable {
    case normal = "NORMAL"
    case sheddingT2 = "SHEDDING_T2"
    case sheddingT1 = "SHEDDING_T1"
    case sheddingSpatial = "SHEDDING_SPATIAL"
    case keyOnly = "KEY_ONLY"
}

// MARK: - 購読（ADR-0025: 判断は購読ごとに独立する）

/// 購読 1 本の状態。判断はすべてここに閉じる。
public struct WhesoSubscription: Equatable {
    public let subscriberId: Int64
    public let targetId: Int64
    public let channel: Int64
    /// 購読者が要求した最大 spatialId（段番号）。
    public let maxSpatialId: Int64
    /// 購読者が要求した最大 temporalId。
    public let maxTemporalId: Int64

    // --- 送信窓（congestion.md 2 節） ---
    /// 送信窓が追跡している段。−1 は「まだ渡していない」を表す。
    public var windowSid: Int64
    /// この購読へ渡した最大 sequenceNumber。
    public var highestSent: Int64
    /// ack で確認された最大 sequenceNumber。
    public var highestAcked: Int64
    /// 最後に ack を受けた時刻。
    public var lastAckAtMs: Int64
    /// ack が途絶えて転送を止めているか。
    public var stalled: Bool

    // --- 輻輳（購読単位で適用する） ---
    public var congestion: WhesoCongestion
    public var congestionEnteredAt: Int64
    /// 輻輳による段の引き下げ量。SHEDDING_SPATIAL 以降で 1 になる。
    public var tierPenalty: Int64
    /// 破棄不可のユニット（優先順位 4・5）を落とした段。落としていなければ −1。
    ///
    /// **規範 1.4**: 順位 4 と 5 を破棄する場合は、デコーダの参照連鎖が壊れるため、
    /// **必ず同一 (senderId, channel, spatialId) の次の KEY ユニットまで連続して破棄し**、
    /// 受信者へ `keyframeRequest` を送る。
    public var awaitingKeySid: Int64

    public init(
        subscriberId: Int64, targetId: Int64, channel: Int64,
        maxSpatialId: Int64, maxTemporalId: Int64,
        windowSid: Int64, highestSent: Int64, highestAcked: Int64,
        lastAckAtMs: Int64, stalled: Bool,
        congestion: WhesoCongestion, congestionEnteredAt: Int64, tierPenalty: Int64,
        awaitingKeySid: Int64
    ) {
        self.subscriberId = subscriberId
        self.targetId = targetId
        self.channel = channel
        self.maxSpatialId = maxSpatialId
        self.maxTemporalId = maxTemporalId
        self.windowSid = windowSid
        self.highestSent = highestSent
        self.highestAcked = highestAcked
        self.lastAckAtMs = lastAckAtMs
        self.stalled = stalled
        self.congestion = congestion
        self.congestionEnteredAt = congestionEnteredAt
        self.tierPenalty = tierPenalty
        self.awaitingKeySid = awaitingKeySid
    }
}

/// はしごの 1 段（ADR-0026）。
public struct WhesoLadderRung: Equatable {
    public let sid: Int64
    public let width: Int64
    public let height: Int64
    public let framerate: Int64
    public let temporalLayers: Int64
    public let targetBitrate: Int64

    public init(sid: Int64, width: Int64, height: Int64, framerate: Int64, temporalLayers: Int64, targetBitrate: Int64) {
        self.sid = sid
        self.width = width
        self.height = height
        self.framerate = framerate
        self.temporalLayers = temporalLayers
        self.targetBitrate = targetBitrate
    }
}

/// 送信者が申告した、または観測されたはしご。
public struct WhesoLadder: Equatable {
    public let from: Int64
    public let ch: Int64
    /// sid の昇順。
    public var rungs: [WhesoLadderRung]
    /// 申告（streamAnnounce）に由来するか。false は観測のみ（fps が分からない）。
    public let announced: Bool

    public init(from: Int64, ch: Int64, rungs: [WhesoLadderRung], announced: Bool) {
        self.from = from
        self.ch = ch
        self.rungs = rungs
        self.announced = announced
    }
}

/// 受信者ごとの遅延勾配。分子と分母の整数対で持つ（ADR-0017）。
public struct WhesoReceiverTrend: Equatable {
    public let subscriberId: Int64
    public let numerator: Int64
    public let denominator: Int64
}

/// 送信者ごとの直近の発話時刻（ADR-0024）。
public struct WhesoSpeakerActivity: Equatable {
    public var senderId: Int64
    public var lastSpeechAtMs: Int64

    public init(senderId: Int64, lastSpeechAtMs: Int64) {
        self.senderId = senderId
        self.lastSpeechAtMs = lastSpeechAtMs
    }
}

/// 送信者 1 人に指令したエンコーダの上限段（ADR-0022）。
public struct WhesoEncoderTier: Equatable {
    public let targetId: Int64
    public let tier: Int64
}

// MARK: - 状態

/// 受け取った位置。ackUpstream の内容になる（受信ノードの印とは別の型である）。
public struct WhesoShardReceivedMark: Equatable {
    public var from: Int64
    public var ch: Int64
    public var sid: Int64
    public var highestSeq: Int64
}

public struct WhesoShardState: Equatable {
    public var participants: [Int64]
    /// 購読の一覧。(subscriberId, targetId, channel) で一意。昇順で保持。
    public var subscriptions: [WhesoSubscription]
    /// 送信者ごとのはしご。(from, ch) の昇順で保持。
    public var ladders: [WhesoLadder]
    /// 受信者ごとの遅延勾配。subscriberId の昇順で保持。
    public var trends: [WhesoReceiverTrend]
    /// 送信者ごとの直近の発話時刻。senderId の昇順で保持。
    public var speakers: [WhesoSpeakerActivity]
    /// 送信者ごとに指令したエンコーダの上限段。targetId の昇順で保持。
    public var encoderTiers: [WhesoEncoderTier]

    // --- ノード全体の予算 ---
    public var budgetBytesPerSec: Int64
    public var sentBytesInWindow: Int64
    public var sentMessagesInWindow: Int64
    public var windowStartMs: Int64
    /// 現在の窓で過負荷を通知したか。
    public var overloadNotified: Bool

    /// 送信者ごとに受け取った最大の sequenceNumber。timer で ackUpstream として返す。
    public var received: [WhesoShardReceivedMark]
    public var unexpectedEvents: [String]
}

// MARK: - 入力イベント

public enum WhesoShardEvent: Equatable {
    case media(from: Int64, ch: Int64, sid: Int64, tid: Int64, key: Bool, bytes: Int64, flags: Int64, seq: Int64)
    case subscribe(from: Int64, to: Int64, ch: Int64, want: Bool, maxSpatialId: Int64, maxTemporalId: Int64)
    case ack(from: Int64, to: Int64, ch: Int64, sid: Int64, highestSeq: Int64)
    case streamAnnounce(from: Int64, ch: Int64, rungs: [WhesoLadderRung])
    case join(id: Int64)
    case leave(id: Int64)
    case link(peer: Int64, state: String)
    case timer
    case budget(bytesPerSec: Int64)
    case report(from: Int64, delayUs: [Int64])
    /// 購読者からのキーフレーム要求（ADR-0039）。購読していない相手への要求は無視して記録する。
    case keyframeRequest(from: Int64, target: Int64, ch: Int64, sid: Int64)
}

// MARK: - 出力コマンド

public enum WhesoShardCommand: Equatable {
    case forward(to: [Int64])
    case drop(priority: Int64, count: Int64)
    case setTier(targetId: Int64, tier: Int64)
    /// キーフレームの要求。段ごとに符号化器が別であるため channel と spatialId を持つ（ADR-0033）。
    case keyframeRequest(targetId: Int64, channel: Int64, spatialId: Int64)
    /// 上流（送信ノード）へ返す受信位置。これが無いと送信ノードの送信窓が開かない。
    case ackUpstream(to: Int64, channel: Int64, spatialId: Int64, highestSeq: Int64)
    case disconnect(peer: Int64)
    case notify(code: Int64)
}

public struct WhesoShardStepResult: Equatable {
    public let state: WhesoShardState
    public let commands: [WhesoShardCommand]
}

// MARK: - 初期状態

public func whesoInitialShardState(_ t: Int64) -> WhesoShardState {
    WhesoShardState(
        participants: [],
        subscriptions: [],
        ladders: [],
        trends: [],
        speakers: [],
        encoderTiers: [],
        budgetBytesPerSec: WhesoConstants.NODE_MAX_OUT_BYTES_PER_SEC,
        sentBytesInWindow: 0,
        sentMessagesInWindow: 0,
        windowStartMs: t,
        overloadNotified: false,
        received: [],
        unexpectedEvents: []
    )
}

// MARK: - ステップ関数

public func whesoShardStep(
    _ state: WhesoShardState,
    _ event: WhesoShardEvent,
    _ t: Int64
) -> WhesoShardStepResult {
    switch event {
    case .media(let from, let ch, let sid, let tid, _, let bytes, let flags, let seq):
        return handleMedia(state, from: from, ch: ch, sid: sid, tid: tid, bytes: bytes, flags: flags, seq: seq, t: t)
    case .subscribe(let from, let to, let ch, let want, let maxSpatialId, let maxTemporalId):
        return handleSubscribe(state, from: from, to: to, ch: ch, want: want, maxSpatialId: maxSpatialId, maxTemporalId: maxTemporalId, t: t)
    case .ack(let from, let to, let ch, let sid, let highestSeq):
        return handleAck(state, from: from, to: to, ch: ch, sid: sid, highestSeq: highestSeq, t: t)
    case .streamAnnounce(let from, let ch, let rungs):
        return handleStreamAnnounce(state, from: from, ch: ch, rungs: rungs, t: t)
    case .join(let id):
        return handleJoin(state, id: id)
    case .leave(let id):
        return handleLeave(state, id: id)
    case .link:
        return ignoreEvent(state, "link")
    case .timer:
        return handleTimer(state, t: t)
    case .budget(let bytesPerSec):
        return handleBudget(state, bytesPerSec: bytesPerSec, t: t)
    case .report(let from, let delayUs):
        return handleReport(state, from: from, delayUs: delayUs, t: t)
    case .keyframeRequest(let from, let target, let ch, let sid):
        return handleKeyframeRequest(state, from: from, target: target, ch: ch, sid: sid)
    }
}

private func ignoreEvent(_ state: WhesoShardState, _ name: String) -> WhesoShardStepResult {
    // 表に無いイベントは無視して記録する。
    var next = state
    next.unexpectedEvents = appendUnexpected(next.unexpectedEvents, name)
    return WhesoShardStepResult(state: next, commands: [])
}

/// 購読者のキーフレーム要求を送信者への要求へ直す（ADR-0039）。
/// 購読が無い相手への要求は無視して記録する。
private func handleKeyframeRequest(
    _ state: WhesoShardState,
    from: Int64, target: Int64, ch: Int64, sid: Int64
) -> WhesoShardStepResult {
    let subscribed = state.subscriptions.contains {
        $0.subscriberId == from && $0.targetId == target && $0.channel == ch
    }
    if !subscribed {
        return ignoreEvent(state, "keyframeRequest")
    }
    return WhesoShardStepResult(
        state: state,
        commands: [.keyframeRequest(targetId: target, channel: ch, spatialId: sid)]
    )
}

// MARK: - 音声チャネルの判定

private func isAudioChannel(_ ch: Int64) -> Bool {
    ch == Int64(WhesoWireLayout.CHANNEL_AUDIO) || ch == Int64(WhesoWireLayout.CHANNEL_SCREEN_AUDIO)
}

// MARK: - メディア

private func handleMedia(
    _ state: WhesoShardState,
    from: Int64, ch: Int64, sid: Int64, tid: Int64,
    bytes: Int64, flags: Int64, seq: Int64, t: Int64
) -> WhesoShardStepResult {
    let windowed = observeLadder(maybeResetWindow(state, t), from: from, ch: ch, sid: sid)

    // 音声で ACTIVE_SPEAKER が立っていれば発話時刻を記録する（選別転送。ADR-0024）。
    let audio = isAudioChannel(ch)
    let speaking = (flags & Int64(WhesoWireLayout.FLAG_ACTIVE_SPEAKER)) != 0
    var withSpeech = windowed
    if audio && speaking {
        withSpeech.speakers = recordSpeech(windowed.speakers, senderId: from, t: t)
    }

    let priority = whesoDropPriority(channel: UInt8(truncatingIfNeeded: ch), flags: UInt8(truncatingIfNeeded: flags))
    let priorityValue: Int64? = priority.map { Int64($0) }

    // 受け取った位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
    withSpeech = markReceived(withSpeech, from: from, ch: ch, sid: sid, seq: seq)

    var targets: [Int64] = []
    var droppedMap: [Int64: Int64] = [:]
    var nextSubscriptions: [WhesoSubscription] = []
    // 参照連鎖が切れた購読が 1 つでもあれば、送信者へキーフレームを 1 度だけ要求する
    // （規範 1.4）。購読ごとに出すと同じ要求が並ぶ。要求は段ごとに 1 件で足りる。
    var wantsKeyframe = false

    for sub in withSpeech.subscriptions {
        if sub.targetId != from || sub.channel != ch {
            nextSubscriptions.append(sub)
            continue
        }
        let decision = decideForSubscription(withSpeech, sub: sub, from: from, ch: ch, sid: sid, tid: tid, flags: flags, seq: seq, priority: priorityValue, t: t)
        nextSubscriptions.append(decision.subscription)
        if decision.requestKeyframe {
            wantsKeyframe = true
        }
        if decision.forward {
            targets.append(sub.subscriberId)
        } else if let dp = decision.dropPriority {
            droppedMap[dp, default: 0] += 1
        }
    }

    targets.sort()

    var commands: [WhesoShardCommand] = []
    // 破棄は優先順位の昇順でまとめて 1 件ずつ報告する。
    let sortedDropKeys = droppedMap.keys.sorted()
    for key in sortedDropKeys {
        if let count = droppedMap[key], count > 0 {
            commands.append(.drop(priority: key, count: count))
        }
    }
    // 破棄の報告の後に置く（順序を固定しないとトレースの完全一致が壊れる）。
    if wantsKeyframe {
        commands.append(.keyframeRequest(targetId: from, channel: ch, spatialId: sid))
    }

    if targets.isEmpty {
        withSpeech.subscriptions = nextSubscriptions
        return WhesoShardStepResult(state: withSpeech, commands: commands)
    }

    commands.append(.forward(to: targets))

    // ノード全体の予算を計上する。転送の可否には使わない（ADR-0025 の 5）。
    withSpeech.subscriptions = nextSubscriptions
    withSpeech.sentMessagesInWindow += Int64(targets.count)
    withSpeech.sentBytesInWindow += Int64(targets.count) * bytes
    let overload = notifyNodeOverload(withSpeech, t: t)
    return WhesoShardStepResult(state: overload.state, commands: commands + overload.commands)
}

// MARK: - 購読 1 本に対する転送可否の決定

private struct SubscriptionDecision {
    let subscription: WhesoSubscription
    let forward: Bool
    let dropPriority: Int64?
    /// 送信者へキーフレームを要求するか（規範 1.4）。
    /// 順位 4・5 を落としたときだけ真になる。
    let requestKeyframe: Bool
}

/// 購読 1 本に対する転送の可否を決める。
/// 判定の順序は TS の decideForSubscription と完全に一致させる。
private func decideForSubscription(
    _ state: WhesoShardState,
    sub: WhesoSubscription,
    from: Int64, ch: Int64, sid: Int64, tid: Int64, flags: Int64, seq: Int64,
    priority: Int64?,
    t: Int64
) -> SubscriptionDecision {
    // 1. ack が途絶えている
    if sub.stalled {
        // 音声は接続が停止していても通す（音声は破棄禁止）。
        // stalled は「ACK_TIMEOUT_MS の間 ack が届かない」状態であり、接続が切れたと
        // 判断したものである。しかし音声を落とすと、復帰しても stalled が解除されない
        // 限り音声が届かない。映像は stalled の間落としてよい（接続が切れた相手へ
        // 映像を送り続けるとノードの予算を食う）。音声だけは通すことで、接続が復帰した
        // ときに音声が即座に戻る。
        if isAudioChannel(ch) {
            return forwardDecision(state, sub: sub, ch: ch, seq: seq)
        }
        return SubscriptionDecision(subscription: sub, forward: false, dropPriority: nil, requestKeyframe: false)
    }

    // 音声の選別転送（ADR-0024、ADR-0029 の 2）。
    // 本数は購読者ごとに決める。輻輳の段が深いほど本数を減らす。
    if isAudioChannel(ch) && !isAudioForwardedForSub(state, sub: sub, senderId: from, t: t) {
        // 輻輳による破棄ではないため priority は 0 とする（ADR-0024 の 5）。
        return SubscriptionDecision(subscription: sub, forward: false, dropPriority: 0, requestKeyframe: false)
    }

    // 音声は段を持たない（spatialId は常に 0）。段の選択は映像のみ。
    if !isAudioChannel(ch) {
        let chosen = chooseRung(state, sub: sub)
        // 2. 段の選択に合わない
        if sid != chosen {
            return SubscriptionDecision(subscription: sub, forward: false, dropPriority: nil, requestKeyframe: false)
        }
        // 3. temporalId の超過
        if tid > sub.maxTemporalId {
            return SubscriptionDecision(subscription: sub, forward: false, dropPriority: nil, requestKeyframe: false)
        }
    }

    let mustForward = priority == nil
    let isKey = (flags & Int64(WhesoWireLayout.FLAG_KEY)) != 0

    // **参照連鎖が切れている間は、次の KEY まで落とし続ける**（規範 1.4）。
    //
    // 順位 4・5 を 1 件落とした後に後続を渡すと、復号器は参照の無いフレームを受け取り、
    // 出力を止める。落とし続ければ復号器は「キーフレーム待ち」に入り、要求で復帰する。
    if !isAudioChannel(ch) && sub.awaitingKeySid == sid {
        if !isKey {
            // 落とす。要求は最初の 1 回で送っているため、ここでは繰り返さない。
            return SubscriptionDecision(subscription: sub, forward: false, dropPriority: priority, requestKeyframe: false)
        }
        // KEY が来た。参照連鎖が回復するため、待ちを解いて渡す。
        var cleared = sub
        cleared.awaitingKeySid = -1
        return forwardDecision(state, sub: cleared, ch: ch, seq: seq)
    }

    // 4. 輻輳状態による破棄
    if !mustForward && shouldDropInCongestion(sub, tid: tid, priority: priority) {
        return dropWithChain(sub, sid: sid, priority: priority)
    }

    // 5. 送信窓が閉じている
    if !mustForward && isWindowClosed(state, sub: sub, seq: seq, ch: ch) {
        return dropWithChain(sub, sid: sid, priority: priority)
    }

    // 6. 転送する
    return forwardDecision(state, sub: sub, ch: ch, seq: seq)
}

/// 破棄する。順位 4・5 なら次の KEY までの連続破棄を始め、キーフレームを要求する（規範 1.4）。
/// 順位 1 から 3（破棄可能なユニット）では連鎖を始めず、要求も作らない。
private func dropWithChain(_ sub: WhesoSubscription, sid: Int64, priority: Int64?) -> SubscriptionDecision {
    let breaksChain = priority == 4 || priority == 5
    if !breaksChain {
        return SubscriptionDecision(subscription: sub, forward: false, dropPriority: priority, requestKeyframe: false)
    }
    var updated = sub
    updated.awaitingKeySid = sid
    return SubscriptionDecision(subscription: updated, forward: false, dropPriority: priority, requestKeyframe: true)
}

/// 転送する。段が変わっていれば窓を作り直す。
private func forwardDecision(_ state: WhesoShardState, sub: WhesoSubscription, ch: Int64, seq: Int64) -> SubscriptionDecision {
    let chosen: Int64 = isAudioChannel(ch) ? 0 : chooseRung(state, sub: sub)
    if chosen != sub.windowSid {
        // 渡す段が変わった。seq の空間が変わるため窓を作り直す。
        var updated = sub
        updated.windowSid = chosen
        updated.highestSent = seq
        updated.highestAcked = seq - 1
        return SubscriptionDecision(subscription: updated, forward: true, dropPriority: nil, requestKeyframe: false)
    }
    var updated = sub
    if seq > sub.highestSent {
        updated.highestSent = seq
    }
    return SubscriptionDecision(subscription: updated, forward: true, dropPriority: nil, requestKeyframe: false)
}

// MARK: - chooseRung（ADR-0027 の 3）

/// この購読へ渡す段を 1 つ選ぶ。
private func chooseRung(_ state: WhesoShardState, sub: WhesoSubscription) -> Int64 {
    let wanted = sub.maxSpatialId - sub.tierPenalty
    let effective = wanted < 0 ? 0 : wanted
    guard let ladder = findLadder(state, from: sub.targetId, ch: sub.channel) else {
        // 段の情報が無い間は要求どおりの段だけを通す。
        return effective
    }
    if ladder.rungs.isEmpty {
        return effective
    }
    var best: Int64 = -1
    var lowest: Int64 = -1
    for rung in ladder.rungs {
        if lowest < 0 || rung.sid < lowest {
            lowest = rung.sid
        }
        if rung.sid <= effective && rung.sid > best {
            best = rung.sid
        }
    }
    if best >= 0 {
        return best
    }
    return lowest < 0 ? effective : lowest
}

// MARK: - isWindowClosed（congestion.md 2 節）

/// 送信窓が閉じているか。交差乗算で比較する（除算を避ける）。
private func isWindowClosed(_ state: WhesoShardState, sub: WhesoSubscription, seq: Int64, ch: Int64) -> Bool {
    let framerate = framerateOf(state, sub: sub)
    if framerate <= 0 {
        return false
    }
    // 窓がまだこの連番の空間に無いときは評価しない（ADR-0038）。
    let chosen: Int64 = isAudioChannel(ch) ? 0 : chooseRung(state, sub: sub)
    if chosen != sub.windowSid {
        return false
    }
    let inFlight = inFlightFrames(sub, seq: seq)
    return inFlight * 1000 > WhesoConstants.SEND_WINDOW_MS * framerate
}

/// 未確認のフレーム数。
private func inFlightFrames(_ sub: WhesoSubscription, seq: Int64) -> Int64 {
    let highest = seq > sub.highestSent ? seq : sub.highestSent
    let inFlight = highest - sub.highestAcked - 1
    return inFlight < 0 ? 0 : inFlight
}

/// この購読が渡している段の fps。申告が無ければ 0 を返す。
private func framerateOf(_ state: WhesoShardState, sub: WhesoSubscription) -> Int64 {
    guard let ladder = findLadder(state, from: sub.targetId, ch: sub.channel) else {
        return 0
    }
    if !ladder.announced {
        return 0
    }
    let chosen = chooseRung(state, sub: sub)
    for rung in ladder.rungs {
        if rung.sid == chosen {
            return rung.framerate
        }
    }
    return 0
}

// MARK: - 輻輳状態による破棄判定

/// 購読単位の輻輳状態に応じた破棄判定。
private func shouldDropInCongestion(_ sub: WhesoSubscription, tid: Int64, priority: Int64?) -> Bool {
    guard let priority else {
        return false
    }
    switch sub.congestion {
    case .normal:
        return false
    case .sheddingT2:
        return priority <= 3
    case .sheddingT1:
        return tid >= 1
    case .sheddingSpatial:
        return tid >= 1
    case .keyOnly:
        return true
    }
}

// MARK: - 音声の選別転送（ADR-0024）

/// 購読者ごとの音声選別転送（ADR-0024、ADR-0029 の 2）。
/// 帯域が細い購読者へ多くの音声を送らないようにする。
private func isAudioForwardedForSub(
    _ state: WhesoShardState,
    sub: WhesoSubscription,
    senderId: Int64,
    t: Int64
) -> Bool {
    let limit = audioLimitFor(sub)
    var active: [WhesoSpeakerActivity] = []
    for entry in state.speakers {
        if t - entry.lastSpeechAtMs <= WhesoConstants.AUDIO_SPEAKER_HOLD_MS {
            active.append(entry)
        }
    }
    if Int64(active.count) <= limit {
        // 上限に達していない。全員の音声を通す。DTX の無音で環境音が
        // 完全に消えると通話が不自然になるためである（ADR-0024 の 6）。
        return true
    }
    let ordered = active.sorted { left, right in
        if left.lastSpeechAtMs != right.lastSpeechAtMs {
            return left.lastSpeechAtMs > right.lastSpeechAtMs
        }
        return left.senderId < right.senderId
    }
    let count = Int(limit)
    for index in 0..<min(ordered.count, count) {
        if ordered[index].senderId == senderId {
            return true
        }
    }
    return false
}

/// この購読者へ同時に転送する音声の本数（ADR-0029 の 2）。
/// 輻輳の段が深いほど減らす。1 本は必ず残す。
private func audioLimitFor(_ sub: WhesoSubscription) -> Int64 {
    let reduced = WhesoConstants.AUDIO_SELECTIVE_FORWARD_COUNT - congestionDepth(sub.congestion)
    return reduced < WhesoConstants.AUDIO_SELECTIVE_MIN_COUNT
        ? WhesoConstants.AUDIO_SELECTIVE_MIN_COUNT
        : reduced
}

/// 輻輳の深さ。NORMAL が 0 で、段が深くなるほど大きい。
private func congestionDepth(_ state: WhesoCongestion) -> Int64 {
    switch state {
    case .normal:
        return 0
    case .sheddingT2:
        return 1
    case .sheddingT1:
        return 2
    case .sheddingSpatial:
        return 3
    case .keyOnly:
        return 4
    }
}

private func recordSpeech(
    _ speakers: [WhesoSpeakerActivity],
    senderId: Int64,
    t: Int64
) -> [WhesoSpeakerActivity] {
    var updated: [WhesoSpeakerActivity] = []
    var replaced = false
    for entry in speakers {
        if entry.senderId == senderId {
            updated.append(WhesoSpeakerActivity(senderId: senderId, lastSpeechAtMs: t))
            replaced = true
            continue
        }
        updated.append(entry)
    }
    if !replaced {
        updated.append(WhesoSpeakerActivity(senderId: senderId, lastSpeechAtMs: t))
        updated.sort { $0.senderId < $1.senderId }
    }
    return updated
}

// MARK: - 購読

private func handleSubscribe(
    _ state: WhesoShardState,
    from: Int64, to: Int64, ch: Int64, want: Bool,
    maxSpatialId: Int64, maxTemporalId: Int64, t: Int64
) -> WhesoShardStepResult {
    let rest = state.subscriptions.filter {
        !($0.subscriberId == from && $0.targetId == to && $0.channel == ch)
    }
    if !want {
        var next = state
        next.subscriptions = rest.sorted(by: subscriptionOrder)
        return withEncoderTiers(next)
    }
    // 既存があれば窓と輻輳の状態を引き継ぐ。
    let existing = state.subscriptions.first {
        $0.subscriberId == from && $0.targetId == to && $0.channel == ch
    }
    let created = WhesoSubscription(
        subscriberId: from,
        targetId: to,
        channel: ch,
        maxSpatialId: maxSpatialId,
        maxTemporalId: maxTemporalId,
        windowSid: existing?.windowSid ?? -1,
        highestSent: existing?.highestSent ?? 0,
        highestAcked: existing?.highestAcked ?? 0,
        lastAckAtMs: t,
        stalled: false,
        congestion: existing?.congestion ?? .normal,
        congestionEnteredAt: existing?.congestionEnteredAt ?? t,
        tierPenalty: existing?.tierPenalty ?? 0,
        awaitingKeySid: existing?.awaitingKeySid ?? -1
    )
    var next = state
    next.subscriptions = (rest + [created]).sorted(by: subscriptionOrder)
    return withEncoderTiers(next)
}

/// 購読の和集合から送信者ごとの必要な上限段を求め、変化した送信者へ setTier を出す（ADR-0022）。
private func withEncoderTiers(_ state: WhesoShardState) -> WhesoShardStepResult {
    var targets: [Int64] = []
    for sub in state.subscriptions {
        if !targets.contains(sub.targetId) {
            targets.append(sub.targetId)
        }
    }
    targets.sort()

    var nextTiers: [WhesoEncoderTier] = []
    var commands: [WhesoShardCommand] = []
    for targetId in targets {
        var tier: Int64 = 0
        for sub in state.subscriptions where sub.targetId == targetId {
            if sub.maxSpatialId > tier {
                tier = sub.maxSpatialId
            }
        }
        nextTiers.append(WhesoEncoderTier(targetId: targetId, tier: tier))
        let previous = state.encoderTiers.first { $0.targetId == targetId }
        if previous == nil || previous?.tier != tier {
            commands.append(.setTier(targetId: targetId, tier: tier))
        }
    }
    var next = state
    next.encoderTiers = nextTiers
    return WhesoShardStepResult(state: next, commands: commands)
}

private func subscriptionOrder(_ a: WhesoSubscription, _ b: WhesoSubscription) -> Bool {
    if a.subscriberId != b.subscriberId {
        return a.subscriberId < b.subscriberId
    }
    if a.targetId != b.targetId {
        return a.targetId < b.targetId
    }
    return a.channel < b.channel
}

// MARK: - ack

private func handleAck(
    _ state: WhesoShardState,
    from: Int64, to: Int64, ch: Int64, sid: Int64, highestSeq: Int64, t: Int64
) -> WhesoShardStepResult {
    guard let targetIndex = state.subscriptions.firstIndex(where: {
        $0.subscriberId == from && $0.targetId == to && $0.channel == ch
    }) else {
        return ignoreEvent(state, "ack")
    }
    let target = state.subscriptions[targetIndex]
    if sid != target.windowSid {
        // 渡していない段への ack。段を変えた直後に古い ack が届くことがある。
        return ignoreEvent(state, "ack")
    }
    // 後戻りする ack は無視する。
    let newHighestAcked = highestSeq > target.highestAcked ? highestSeq : target.highestAcked
    var updated = target
    updated.highestAcked = newHighestAcked
    updated.lastAckAtMs = t
    updated.stalled = false
    var next = state
    next.subscriptions = (state.subscriptions.filter { !($0.subscriberId == from && $0.targetId == to && $0.channel == ch) } + [updated]).sorted(by: subscriptionOrder)
    // ack で未確認量が減るため、輻輳状態を再評価する。
    return evaluateAll(next, t: t)
}

// MARK: - streamAnnounce

private func handleStreamAnnounce(
    _ state: WhesoShardState,
    from: Int64, ch: Int64, rungs: [WhesoLadderRung], t: Int64
) -> WhesoShardStepResult {
    let sortedRungs = rungs.sorted { $0.sid < $1.sid }
    let rest = state.ladders.filter { !($0.from == from && $0.ch == ch) }
    let ladder = WhesoLadder(from: from, ch: ch, rungs: sortedRungs, announced: true)
    var next = state
    next.ladders = (rest + [ladder]).sorted(by: ladderOrder)
    // はしごが変わると選ぶ段と fps が変わるため、輻輳状態を再評価する。
    return evaluateAll(next, t: t)
}

/// 観測からはしごを補う。申告が届く前でも段の集合が分かる。
private func observeLadder(_ state: WhesoShardState, from: Int64, ch: Int64, sid: Int64) -> WhesoShardState {
    if isAudioChannel(ch) {
        // 音声は段を持たない。
        return state
    }
    if let existing = findLadder(state, from: from, ch: ch) {
        if existing.announced || existing.rungs.contains(where: { $0.sid == sid }) {
            return state
        }
        let newRungs = (existing.rungs + [observedRung(sid)]).sorted { $0.sid < $1.sid }
        let rest = state.ladders.filter { !($0.from == from && $0.ch == ch) }
        var next = state
        next.ladders = (rest + [WhesoLadder(from: from, ch: ch, rungs: newRungs, announced: false)]).sorted(by: ladderOrder)
        return next
    }
    let created = WhesoLadder(from: from, ch: ch, rungs: [observedRung(sid)], announced: false)
    var next = state
    next.ladders = (state.ladders + [created]).sorted(by: ladderOrder)
    return next
}

/// 観測のみで作る段。寸法とビットレートは不明であるため 0。
private func observedRung(_ sid: Int64) -> WhesoLadderRung {
    WhesoLadderRung(sid: sid, width: 0, height: 0, framerate: 0, temporalLayers: 0, targetBitrate: 0)
}

private func findLadder(_ state: WhesoShardState, from: Int64, ch: Int64) -> WhesoLadder? {
    state.ladders.first { $0.from == from && $0.ch == ch }
}

private func ladderOrder(_ a: WhesoLadder, _ b: WhesoLadder) -> Bool {
    a.from != b.from ? a.from < b.from : a.ch < b.ch
}

// MARK: - 参加と退出

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
    next.trends = state.trends.filter { $0.subscriberId != id }
    next.ladders = state.ladders.filter { $0.from != id }
    next.speakers = state.speakers.filter { $0.senderId != id }
    next.encoderTiers = state.encoderTiers.filter { $0.targetId != id }
    next.received = state.received.filter { $0.from != id }
    return withEncoderTiers(next)
}

// MARK: - タイマー・予算・報告

private func handleTimer(_ state: WhesoShardState, t: Int64) -> WhesoShardStepResult {
    let windowed = maybeResetWindow(state, t)
    let stalled = detectAckTimeout(windowed, t: t)
    let evaluated = evaluateAll(stalled.state, t: t)
    // 上流（送信ノード）へ受信位置を返す。返さないと送信ノードの窓が開かない。
    let acks: [WhesoShardCommand] = evaluated.state.received.map {
        .ackUpstream(to: $0.from, channel: $0.ch, spatialId: $0.sid, highestSeq: $0.highestSeq)
    }
    return WhesoShardStepResult(
        state: evaluated.state,
        commands: stalled.commands + evaluated.commands + acks
    )
}

/// 受け取った位置を更新する。後戻りする値では更新しない。順序は from, ch, sid の昇順。
private func markReceived(
    _ state: WhesoShardState,
    from: Int64, ch: Int64, sid: Int64, seq: Int64
) -> WhesoShardState {
    if seq <= 0 {
        return state
    }
    if let existing = state.received.first(where: { $0.from == from && $0.ch == ch && $0.sid == sid }),
        existing.highestSeq >= seq
    {
        return state
    }
    var next = state
    next.received = state.received.filter { !($0.from == from && $0.ch == ch && $0.sid == sid) }
    next.received.append(WhesoShardReceivedMark(from: from, ch: ch, sid: sid, highestSeq: seq))
    next.received.sort {
        if $0.from != $1.from { return $0.from < $1.from }
        if $0.ch != $1.ch { return $0.ch < $1.ch }
        return $0.sid < $1.sid
    }
    return next
}

/// ack が途絶えた購読を検出する。
/// 未確認の媒体が無い購読は対象にしない（何も渡していない相手には返すべき ack が無い）。
private func detectAckTimeout(_ state: WhesoShardState, t: Int64) -> WhesoShardStepResult {
    var commands: [WhesoShardCommand] = []
    var subscriptions: [WhesoSubscription] = []
    for var sub in state.subscriptions {
        let outstanding = sub.highestSent > sub.highestAcked
        if !sub.stalled && !outstanding {
            // 未確認が無い間は時計を進める（ADR-0041）。
            // 「無通信」と「無応答」を区別するため、未確認の媒体が無い購読は
            // lastAckAtMs を現在時刻で更新する。
            sub.lastAckAtMs = t
            subscriptions.append(sub)
            continue
        }
        if sub.stalled || t - sub.lastAckAtMs < WhesoConstants.ACK_TIMEOUT_MS {
            subscriptions.append(sub)
            continue
        }
        sub.stalled = true
        subscriptions.append(sub)
        commands.append(.disconnect(peer: sub.subscriberId))
    }
    var next = state
    next.subscriptions = subscriptions
    return WhesoShardStepResult(state: next, commands: commands)
}

private func handleBudget(_ state: WhesoShardState, bytesPerSec: Int64, t: Int64) -> WhesoShardStepResult {
    var next = state
    next.budgetBytesPerSec = bytesPerSec
    return evaluateAll(next, t: t)
}

private func handleReport(_ state: WhesoShardState, from: Int64, delayUs: [Int64], t: Int64) -> WhesoShardStepResult {
    let slope = whesoDelaySlope(delayUs)
    let rest = state.trends.filter { $0.subscriberId != from }
    let updated = WhesoReceiverTrend(subscriberId: from, numerator: slope.numerator, denominator: slope.denominator)
    var next = state
    next.trends = (rest + [updated]).sorted { $0.subscriberId < $1.subscriberId }
    return evaluateAll(next, t: t)
}

// MARK: - 輻輳状態の遷移（購読単位）

/// すべての購読の輻輳状態を評価する。購読ごとに独立（congestion.md 7 節）。
private func evaluateAll(_ state: WhesoShardState, t: Int64) -> WhesoShardStepResult {
    var commands: [WhesoShardCommand] = []
    var subscriptions: [WhesoSubscription] = []
    for sub in state.subscriptions {
        let result = evaluateSubscription(state, sub: sub, t: t)
        subscriptions.append(result.subscription)
        commands.append(contentsOf: result.commands)
    }
    var next = state
    next.subscriptions = subscriptions
    return WhesoShardStepResult(state: next, commands: commands)
}

private struct EvaluateResult {
    let subscription: WhesoSubscription
    let commands: [WhesoShardCommand]
}

private func evaluateSubscription(_ state: WhesoShardState, sub: WhesoSubscription, t: Int64) -> EvaluateResult {
    // ヒステリシス: 現状態に入ってから SHEDDING_HYSTERESIS_MS 以内は遷移しない。
    if t - sub.congestionEnteredAt < WhesoConstants.SHEDDING_HYSTERESIS_MS {
        return EvaluateResult(subscription: sub, commands: [])
    }

    var next = sub.congestion
    switch sub.congestion {
    case .normal:
        if fillGreater(state, sub: sub, num: WhesoConstants.SHARD_UTIL_ENTER_T2_NUM, den: WhesoConstants.SHARD_UTIL_ENTER_T2_DEN)
            || trendGreater(state, sub: sub, num: WhesoConstants.SHARD_TREND_ENTER_T2_NUM, den: WhesoConstants.SHARD_TREND_ENTER_T2_DEN) {
            next = .sheddingT2
        }
    case .sheddingT2:
        if fillGreater(state, sub: sub, num: WhesoConstants.SHARD_UTIL_ENTER_T1_NUM, den: WhesoConstants.SHARD_UTIL_ENTER_T1_DEN)
            || trendGreater(state, sub: sub, num: WhesoConstants.SHARD_TREND_ENTER_T1_NUM, den: WhesoConstants.SHARD_TREND_ENTER_T1_DEN) {
            next = .sheddingT1
        } else if fillLess(state, sub: sub, num: WhesoConstants.SHARD_UTIL_EXIT_T2_NUM, den: WhesoConstants.SHARD_UTIL_EXIT_T2_DEN)
            && trendLess(state, sub: sub, num: WhesoConstants.SHARD_TREND_EXIT_NUM, den: WhesoConstants.SHARD_TREND_EXIT_DEN) {
            next = .normal
        }
    case .sheddingT1:
        if fillGreater(state, sub: sub, num: WhesoConstants.SHARD_UTIL_ENTER_SPATIAL_NUM, den: WhesoConstants.SHARD_UTIL_ENTER_SPATIAL_DEN)
            || trendGreater(state, sub: sub, num: WhesoConstants.SHARD_TREND_ENTER_SPATIAL_NUM, den: WhesoConstants.SHARD_TREND_ENTER_SPATIAL_DEN) {
            next = .sheddingSpatial
        } else if fillLess(state, sub: sub, num: WhesoConstants.SHARD_UTIL_EXIT_T1_NUM, den: WhesoConstants.SHARD_UTIL_EXIT_T1_DEN)
            && trendLess(state, sub: sub, num: WhesoConstants.SHARD_TREND_EXIT_NUM, den: WhesoConstants.SHARD_TREND_EXIT_DEN) {
            next = .sheddingT2
        }
    case .sheddingSpatial:
        if fillGreater(state, sub: sub, num: WhesoConstants.SHARD_UTIL_ENTER_KEY_ONLY_NUM, den: WhesoConstants.SHARD_UTIL_ENTER_KEY_ONLY_DEN)
            || trendGreater(state, sub: sub, num: WhesoConstants.SHARD_TREND_ENTER_KEY_ONLY_NUM, den: WhesoConstants.SHARD_TREND_ENTER_KEY_ONLY_DEN) {
            next = .keyOnly
        } else if fillLess(state, sub: sub, num: WhesoConstants.SHARD_UTIL_EXIT_SPATIAL_NUM, den: WhesoConstants.SHARD_UTIL_EXIT_SPATIAL_DEN)
            && trendLess(state, sub: sub, num: WhesoConstants.SHARD_TREND_EXIT_NUM, den: WhesoConstants.SHARD_TREND_EXIT_DEN) {
            next = .sheddingT1
        }
    case .keyOnly:
        if fillLess(state, sub: sub, num: WhesoConstants.SHARD_UTIL_EXIT_KEY_ONLY_NUM, den: WhesoConstants.SHARD_UTIL_EXIT_KEY_ONLY_DEN)
            && trendLess(state, sub: sub, num: WhesoConstants.SHARD_TREND_EXIT_KEY_ONLY_NUM, den: WhesoConstants.SHARD_TREND_EXIT_KEY_ONLY_DEN) {
            next = .sheddingSpatial
        }
    }

    if next == sub.congestion {
        return EvaluateResult(subscription: sub, commands: [])
    }

    // SHEDDING_SPATIAL 以降は段を 1 つ下げる。
    let penalty: Int64 = (next == .sheddingSpatial || next == .keyOnly) ? 1 : 0
    var updated = sub
    updated.congestion = next
    updated.congestionEnteredAt = t
    updated.tierPenalty = penalty

    var commands: [WhesoShardCommand] = []
    if penalty != sub.tierPenalty {
        // 購読者へ setTier を送ってはならない（ADR-0033）。段の変化は媒体の spatialId で伝わる。
        commands.append(
            .keyframeRequest(
                targetId: sub.targetId,
                channel: sub.channel,
                spatialId: chooseRung(state, sub: updated)
            )
        )
    }
    return EvaluateResult(subscription: updated, commands: commands)
}

// MARK: - fillGreater / fillLess（送信窓の充填率）

/// 送信窓の充填率が閾値を超えているか（購読単位）。
private func fillGreater(_ state: WhesoShardState, sub: WhesoSubscription, num: Int64, den: Int64) -> Bool {
    let framerate = framerateOf(state, sub: sub)
    if framerate <= 0 {
        return false
    }
    let inFlight = inFlightFrames(sub, seq: sub.highestSent)
    return inFlight * 1000 * den > num * WhesoConstants.SEND_WINDOW_MS * framerate
}

private func fillLess(_ state: WhesoShardState, sub: WhesoSubscription, num: Int64, den: Int64) -> Bool {
    let framerate = framerateOf(state, sub: sub)
    if framerate <= 0 {
        // 充填率を評価できない。回復を妨げないため、条件を満たすとみなす。
        return num > 0
    }
    let inFlight = inFlightFrames(sub, seq: sub.highestSent)
    return inFlight * 1000 * den < num * WhesoConstants.SEND_WINDOW_MS * framerate
}

// MARK: - trendGreater / trendLess（遅延勾配、購読者単位）

/// この購読者の遅延勾配が閾値を超えているか。他の購読者の勾配は見ない（ADR-0025 の 4）。
private func trendGreater(_ state: WhesoShardState, sub: WhesoSubscription, num: Int64, den: Int64) -> Bool {
    guard let trend = state.trends.first(where: { $0.subscriberId == sub.subscriberId }) else {
        return false
    }
    return trend.numerator * den > num * trend.denominator
}

/// 報告が無い場合は回復条件を満たすとみなす。
private func trendLess(_ state: WhesoShardState, sub: WhesoSubscription, num: Int64, den: Int64) -> Bool {
    guard let trend = state.trends.first(where: { $0.subscriberId == sub.subscriberId }) else {
        return true
    }
    return trend.numerator * den < num * trend.denominator
}

// MARK: - ノード全体の予算

/// ノード全体の予算超過を制御系へ通知する。転送の可否には使わない（ADR-0025 の 5）。
private func notifyNodeOverload(_ state: WhesoShardState, t: Int64) -> WhesoShardStepResult {
    if state.overloadNotified {
        return WhesoShardStepResult(state: state, commands: [])
    }
    let elapsed = t - state.windowStartMs
    if elapsed <= 0 {
        return WhesoShardStepResult(state: state, commands: [])
    }
    let messagesOver = state.sentMessagesInWindow * 1000 > WhesoConstants.NODE_MAX_OUT_MESSAGES_PER_SEC * elapsed
    let bytesOver = state.sentBytesInWindow * 1000 > state.budgetBytesPerSec * elapsed
    if !messagesOver && !bytesOver {
        return WhesoShardStepResult(state: state, commands: [])
    }
    var next = state
    next.overloadNotified = true
    return WhesoShardStepResult(state: next, commands: [.notify(code: WhesoErrors.E_NODE_OVERLOADED_CLOSE_CODE)])
}

private func maybeResetWindow(_ state: WhesoShardState, _ t: Int64) -> WhesoShardState {
    let elapsed = t - state.windowStartMs
    if elapsed >= WhesoConstants.SHARD_UTIL_WINDOW_MS {
        var next = state
        next.sentBytesInWindow = 0
        next.sentMessagesInWindow = 0
        next.windowStartMs = t
        next.overloadNotified = false
        return next
    }
    return state
}

/// 表に無いイベントの記録に 1 件加える。上限を超えたら古い側を捨てる（ADR-0034）。
/// 上限が無いと記録が無制限に伸び、Durable Object の記憶（128 MB。F-006）を食う。
func appendUnexpected(_ events: [String], _ name: String) -> [String] {
    var appended = events
    appended.append(name)
    let limit = Int(WhesoConstants.MAX_UNEXPECTED_EVENTS)
    if appended.count > limit {
        return Array(appended.suffix(limit))
    }
    return appended
}
