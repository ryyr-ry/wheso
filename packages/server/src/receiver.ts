/**
 * 受信ノード（receiver）の Durable Object 入口。
 *
 * 判断は書かない。責務は接続と時刻という副作用の扱いのみである。
 * PartyKit は既定輸出のクラスを要求するため、本ファイルのみ既定輸出を用いる
 * （lint-policy.md 9.4 の例外）。
 *
 * 接続の形:
 *   - 入ってくる接続 … 受信側クライアント。`hello` のトークンを検証し `helloAck` を返す。
 *     予備接続（standby）があるため 1 人でも複数本になる（client-architecture.md 2 節）
 *   - 出ていく接続   … 割当先の中継ノード 1 本。`nodeHello` の HMAC で認証する
 *
 * **入ってくる「上流」を受け付けない。** 以前は `?role=upstream` という問い合わせ文字列を
 * 信用して媒体をクライアントへ素通ししていた。部屋名は決定論的であるため、名前を知る
 * 第三者が任意の映像を送り込めた。媒体は自分が張った接続からのみ受け取る。
 */

import type * as Party from "partykit/server";

import {
  ACK_TIMEOUT_MS, ACK_INTERVAL_MS, NODE_CONNECT_TIMEOUT_MS } from "@wheso/core/src/generated/constants.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";
import { REGION_AUTO, resolveAudioShard, resolveVideoShard } from "@wheso/core/src/naming.ts";

import { admitClient, meetingIdFromPersonalRoom } from "./client-auth.ts";
import { deriveMeetingSecret, verifyNodeAuthTag } from "@wheso/core/src/auth.ts";
import { openNodeLink, type NodeLink } from "./node-link.ts";
import {
  createReceiverHandlerState,
  handleAckTimer,
  handleClientBinary,
  handleClientText,
  handleUpstreamBinary,
  upstreamSubscribeText,
  type ReceiverHandlerState,
  type ReceiverTransport,
} from "./receiver-handler.ts";

/** 認証前の接続に許す猶予。これを超えて hello が来ない接続は閉じる（auth.md 5 節）。 */
const HELLO_TIMEOUT_MS = 5000;

/**
 * 上流の接続が整う前に溜める制御メッセージの上限。
 * 報告は周期的に届くため、上限が無いと記憶が伸びる。古い側を捨てる。
 */
const MAX_PENDING_UPSTREAM = 32;

/** この部屋が担う役割。`vr` は映像、`ar` は音声である。 */
type ReceiveRole = "vr" | "ar";

export class ReceiverNode implements Party.Server {
  private state: ReceiverHandlerState;

  /** 認証を通ったクライアント接続。予備接続があるため複数になる。 */
  private readonly clients = new Set<string>();
  /**
   * 接続を開いた時刻（接続 ID → ミリ秒）。**認証の猶予を接続ごとに数えるために持つ。**
   * アラームの刻みを猶予と混同すると、開いた直後の接続が `hello` の到着前に閉じられる。
   */
  private readonly openedAtMs = new Map<string, number>();

  /**
   * 認証の処理中の接続。
   *
   * `hello` の検証は非同期（署名の検証）である。その間に別のメッセージが届くと、
   * 「最初の 1 通は hello である」という前提で解析して失敗し、形式違反として
   * 接続を閉じてしまう（実測: 受信部屋が `report` を hello と解釈して 4020 で切った）。
   * 処理中の接続からのメッセージは**捨てる**（報告は周期的、購読は ACTIVE で送り直される）。
   */
  private readonly authenticating = new Set<string>();

  /** 割当先の中継ノードへの接続。 */
  private upstream: NodeLink | null = null;

  /** 接続の確立中に二重に開かないための印。 */
  private connecting = false;

  /** 直近に確立を試みた時刻。試行が返らない場合に再試行するために持つ（F-046）。 */
  private attemptAtMs = 0;

  /**
   * 上流の接続が整う前に送ろうとした制御メッセージ。
   *
   * 接続の確立は背後で進む（`await` すると入力ゲートで握手が完了しない。F-046）。
   * その間に届いた購読を捨てると、**クライアントは購読を送り直さないため永久に映像が来ない**
   * （送り直しは `ACTIVE` へ入る遷移のときだけである。ADR-0032）。溜めて、開いたら送る。
   */
  private pendingUpstream: string[] = [];

  /** 最後に望む集合を上流へ押し付けた時刻。`ACK_TIMEOUT_MS` ごとに送り直す（F-056）。 */
  private resyncAtMs = 0;

  /** 最後に ack を返した時刻。媒体の到着で返すため記録する（F-064）。 */
  private lastAckTickAtMs = 0;

  /**
   * 購読を送ってきたクライアント接続。媒体はここだけへ流す（F-058）。
   *
   * 予備接続は定常状態では購読しないため、ここに入らない。切替のときに購読すれば入る。
   */
  private readonly subscribedClients = new Set<string>();

  /** 観測のための計数。判断には使わない。 */
  private counters = { upstreamBinaryIn: 0, toClient: 0, clientTextIn: 0, alarms: 0, upstreamTextOut: 0 };

  /** この部屋の会議 ID と利用者 ID。`onMessage` の文脈でのみ決める。 */
  private identity: { readonly meetingId: string; readonly userId: string; readonly role: ReceiveRole } | null =
    null;

  private readonly transport: ReceiverTransport;

  constructor(readonly room: Party.Room) {
    this.state = createReceiverHandlerState(Date.now());
    this.transport = {
      sendToClient: (bytes) => {
        this.counters = { ...this.counters, toClient: this.counters.toClient + 1 };
        // **購読した接続だけへ送る**（F-058）。
        //
        // 予備接続（standby）は同じ部屋への 2 本目である。規範では予備が購読するのは
        // **切替のときだけ**であり（congestion.md 6 節の規則 1）、定常状態では購読しない。
        // 以前は認証を通った全接続へ送っていたため、予備が居るだけで媒体が二重に流れた
        // （実測: 40 件送ったのにクライアントは 62 件受け取った）。二重配送は下り帯域を
        // 倍にし、復号器へ同じフレームを 2 度渡す。
        //
        // 切替の最中は新旧の両方が購読しているため両方へ送る。旧接続からのフレームを
        // 捨てるのはクライアントの責務である（同 6 節の規則 3）。
        this.eachSubscribedClient((connection) => connection.send(bytes));
      },
      sendTextToClient: (text) => {
        this.eachClient((connection) => connection.send(text));
      },
      sendUpstream: (text) => {
        const link = this.upstream;
        if (link === null) {
          this.pendingUpstream.push(text);
          if (this.pendingUpstream.length > MAX_PENDING_UPSTREAM) {
            this.pendingUpstream.shift();
          }
          return;
        }
        this.counters = { ...this.counters, upstreamTextOut: this.counters.upstreamTextOut + 1 };
        link.sendText(text);
      },
      closeClient: (code, reason) => {
        this.eachClient((connection) => connection.close(code, reason));
      },
    };
  }

  /**
   * 望む集合を上流へ送り直す。
   *
   * 中継ノードの購読は接続の生存に紐づくため、こちらの状態を真として押し付ける。
   * `ACK_TIMEOUT_MS` ごとに行う。中継はこの時間 ack が無い購読を停止と見なすため、
   * 復帰までの時間を規範が既に認めている無応答の上限に合わせられる。
   */
  private resyncUpstream(): void {
    const link = this.upstream;
    if (link === null) {
      return;
    }
    const text = upstreamSubscribeText(this.state.core);
    this.counters = { ...this.counters, upstreamTextOut: this.counters.upstreamTextOut + 1 };
    this.resyncAtMs = Date.now();
    link.sendText(text);
  }

  onConnect(connection: Party.Connection): void {
    // 認証の猶予と ack の周期をこのアラームで兼ねる。
    //
    // **猶予は接続ごとに数える。** アラームは認証が済んだ後 `ACK_INTERVAL_MS`（50 ms）で
    // 回り続ける。「アラームが鳴ったら未認証の接続を閉じる」と書くと、猶予は
    // `HELLO_TIMEOUT_MS` ではなく**次の刻みまで**になり、開いた直後の接続が
    // `hello` の到着を待たずに閉じられる。予備接続（同じ部屋への 2 本目）と再接続が
    // これで死んだ（実測: `vr` が 4020「hello timeout」で落ち、以後 1 枚も届かない）。
    this.openedAtMs.set(connection.id, Date.now());
    void this.room.storage.setAlarm(Date.now() + HELLO_TIMEOUT_MS);
  }

  onClose(connection: Party.Connection): void {
    this.clients.delete(connection.id);
    this.authenticating.delete(connection.id);
    this.subscribedClients.delete(connection.id);
    this.openedAtMs.delete(connection.id);
  }

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection): Promise<void> {
    const now = Date.now();

    if (typeof message === "string") {
      if (!this.clients.has(sender.id)) {
        if (this.authenticating.has(sender.id)) {
          // 認証の処理中である。捨てる（hello として解釈してはならない）。
          return;
        }
        this.authenticating.add(sender.id);
        await this.authenticateClient(message, sender, now);
        this.authenticating.delete(sender.id);
        return;
      }
      // **心拍に応える**（規範 1 節の `HEARTBEAT_TIMEOUT_MS`）。
      //
      // 応えないと、静かな部屋（`as` など）では受信が 1 度も起きないため、クライアントは
      // 「切れた」ことを知る手立てを持たない。実測（段 E）: 経路を落としたとき `close` の
      // 事象が来ず、`ar` が再接続しないまま**音声が二度と戻らなかった**。
      if (message.includes('"t":"heartbeat"')) {
        sender.send(JSON.stringify({ t: "heartbeatAck" }));
        return;
      }
      // 購読や報告を受けた時点で割当先への接続を確かめる。
      // **接続はアラームからは張れない**（`onAlarm` は `context.parties` へ触れられない）。
      // **`await` してはならない。** Durable Object は 1 つの入力を処理している間、
      // 次の入力を受け付けない（入力ゲート）。`stub.socket()` の確立は相手の応答を必要と
      // するため、`onMessage` の中で待つと自分の入力ゲートが閉じたまま握手が完了せず、
      // 永久に確立しない（実測: F-046）。確立は背後で進めさせ、この購読は次の機会に送る。
      void this.ensureUpstream();
      this.counters = { ...this.counters, clientTextIn: this.counters.clientTextIn + 1 };
      // 購読を送ってきた接続を覚える。媒体はここだけへ流す（F-058）。
      // 予備接続は切替のときだけ購読するため、そのときに加わる。
      if (message.includes('"t":"subscribe"')) {
        this.subscribedClients.add(sender.id);
      }
      this.state = handleClientText(this.state, message, now, this.transport);
      return;
    }

    const bytes = new Uint8Array(message);
    if (!this.clients.has(sender.id)) {
      // 認証前のメディアは扱わない（wire-format.md 2.8）。
      return;
    }
    // 受信ノードはクライアントからのメディアを扱わない。形式違反のみ検出して閉じる。
    this.state = handleClientBinary(this.state, bytes, now, this.transport);
  }

  /**
   * 観測の口（observability.md）。認証は `nodeHello` と同じ HMAC を頭部で受ける。
   *
   * 媒体が届かないとき、原因が「上流が無い」「購読が無い」「ack を返していない」の
   * どれなのかを外から区別するために持つ。**会議の内容は返さない。**
   */
  async onRequest(request: Party.Request): Promise<Response> {
    const role = request.headers.get("x-wheso-node-role");
    const tag = request.headers.get("x-wheso-node-auth");
    const identity = this.identity;
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (role === null || tag === null || identity === null || typeof nodeKey !== "string") {
      return new Response(JSON.stringify({ t: "error", code: "E_NODE_AUTH" }), { status: 401 });
    }
    const secret = await deriveMeetingSecret(new TextEncoder().encode(nodeKey), identity.meetingId);
    if (!secret.ok) {
      return new Response(JSON.stringify({ t: "error", code: "E_NODE_AUTH" }), { status: 401 });
    }
    const verified = await verifyNodeAuthTag(secret.value, this.room.id, role, tag, Math.trunc(Date.now() / 1000));
    if (!verified.ok) {
      return new Response(JSON.stringify({ t: "error", code: "E_NODE_AUTH" }), { status: 401 });
    }
    return new Response(
      JSON.stringify({
        t: "receiverStatus",
        clients: this.clients.size,
        upstream: this.upstream === null ? null : { ready: this.upstream.isReady() },
        pendingUpstream: this.pendingUpstream.length,
        streams: this.state.core.streams,
        received: this.state.core.received,
        targetBytesPerSec: this.state.core.targetBytesPerSec,
        audioOnly: this.state.core.audioOnly,
        counters: this.counters,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  onAlarm(): void {
    const now = Date.now();
    // 猶予を過ぎた未認証の接続を閉じる。放置すると接続だけを張る濫用を許す。
    // **経過は接続ごとに見る**（アラームの刻みは 50 ms であり猶予ではない）。
    for (const connection of this.room.getConnections()) {
      if (this.clients.has(connection.id)) {
        continue;
      }
      const openedAt = this.openedAtMs.get(connection.id);
      if (openedAt === undefined) {
        // **開いた時刻を知らない接続は、その場で猶予を与え直す。** この表は isolate の
        // 記憶であり、実行環境が入れ替わると空になる（F-046）。空を「猶予切れ」と読むと、
        // 入れ替わりの直後に生きている接続を全部閉じる（実測: 音声受信部屋が 4020 で死んだ）。
        this.openedAtMs.set(connection.id, now);
        continue;
      }
      if (now - openedAt < HELLO_TIMEOUT_MS) {
        continue;
      }
      connection.close(ERROR_DEFINITIONS.E_HELLO_TIMEOUT.closeCode, "hello timeout");
    }
    // ACK_INTERVAL_MS ごとに受信位置を上流へ返す（congestion.md 2 節）。
    this.counters = { ...this.counters, alarms: this.counters.alarms + 1 };
    this.state = handleAckTimer(this.state, now, this.transport);
    // 望む集合を押し付け直す。中継ノードが購読を失っていても自力で復帰する（F-056）。
    if (now - this.resyncAtMs >= ACK_TIMEOUT_MS && this.state.core.streams.length > 0) {
      this.resyncUpstream();
    }
    if (this.clients.size > 0) {
      // 接続がある間だけ起き続ける。誰も居ない部屋を起こし続けない。
      void this.room.storage.setAlarm(now + ACK_INTERVAL_MS);
    }
  }

  /** クライアントの `hello` を検証し、通れば `helloAck` を返す。 */
  private async authenticateClient(text: string, sender: Party.Connection, nowMs: number): Promise<void> {
    const tokenKey = this.room.env["WHESO_TOKEN_KEY"];
    const role = this.roleOfRoom();
    const admitted = await admitClient({
      roomId: this.room.id,
      expectedRole: role,
      tokenKey: typeof tokenKey === "string" ? tokenKey : "",
      text,
      nowMs,
    });
    if (!admitted.ok) {
      sender.close(admitted.error.closeCode, admitted.error.code);
      return;
    }
    const meetingId = meetingIdFromPersonalRoom(this.room.id, role);
    const userId = this.room.id.split("-")[2];
    if (meetingId !== null && userId !== undefined) {
      this.identity = { meetingId, userId, role };
    }
    this.clients.add(sender.id);
    // **ここで ack の周期を始める。** 接続時のアラームは認証の猶予（5 秒）に合わせてあり、
    // それを待つと最初の 5 秒間 ack を 1 件も返せない。その間に中継ノードの送信窓が閉じ
    // （`framerate` 15 なら 3 枚で閉じる）、さらに `ACK_TIMEOUT_MS` で購読が切られる。
    // 実測では 30 枚のうち 4 枚しか届かなかった原因がこれである。
    void this.room.storage.setAlarm(Date.now() + ACK_INTERVAL_MS);
    sender.send(admitted.value.ackText);
  }

  /**
   * 割当先の中継ノードへの接続を確かめる。無ければ張る。
   *
   * **単一シャードの前提を明示する。** シャード数が 1 のとき Rendezvous の結果は
   * 必ず 0 であるため、購読する送信者の利用者 ID を知らなくても部屋名が決まる。
   * 複数シャードでは送信者ごとに部屋が変わるため、`meta` が配る割当表とファンアウト木が
   * 必要である（state-machines.md 3 節・4 節。段 5）。ここで推測してはならない。
   */
  private async ensureUpstream(): Promise<void> {
    if (this.upstream !== null) {
      return;
    }
    if (this.connecting && Date.now() - this.attemptAtMs < NODE_CONNECT_TIMEOUT_MS) {
      return;
    }
    const identity = this.identity;
    if (identity === null) {
      return;
    }
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (typeof nodeKey !== "string" || nodeKey.length === 0) {
      return;
    }
    const input = {
      userId: identity.userId,
      meetingId: identity.meetingId,
      region: REGION_AUTO,
      epoch: 1,
      shardCount: 1,
      overrides: new Map<string, number>(),
    };
    const assignment = identity.role === "vr" ? resolveVideoShard(input) : resolveAudioShard(input);
    if (!assignment.ok) {
      return;
    }
    this.connecting = true;
    this.attemptAtMs = Date.now();
    const link = await openNodeLink({
      room: this.room,
      party: "shard",
      targetRoom: assignment.value.roomName,
      meetingId: identity.meetingId,
      role: "receiver",
      nodeKey,
      nowMs: Date.now(),
      onText: () => {
        // 中継ノードからの制御メッセージは現時点で扱う対象が無い。未知として無視する。
      },
      onBinary: (bytes) => {
        const at = Date.now();
        this.counters = { ...this.counters, upstreamBinaryIn: this.counters.upstreamBinaryIn + 1 };
        this.state = handleUpstreamBinary(this.state, bytes, at, this.transport);
        // **媒体の到着に合わせて ack を返す**（F-064）。
        //
        // 規範は `ACK_INTERVAL_MS`（50 ms）ごとの ack を前提に中継ノードの送信窓を
        // 定めているが、実行環境のアラームはそれより粗く発火する。ack が遅れると
        // 中継ノードの窓が埋まり、購読の輻輳状態が `KEY_ONLY` まで進んで映像が止まる
        // （実測: 刻みの観測で `cong=KEY_ONLY`、40 件のうち 12 件しか転送されなかった）。
        // 媒体が流れている間は入力があるため、入力に合わせて返せばアラームに依らない。
        if (at - this.lastAckTickAtMs >= ACK_INTERVAL_MS) {
          this.lastAckTickAtMs = at;
          this.state = handleAckTimer(this.state, at, this.transport);
        }
      },
      onClose: () => {
        this.upstream = null;
      },
    });
    this.connecting = false;
    if (!link.ok) {
      return;
    }
    this.upstream = link.value;
    // 溜めていた購読を送る。送らないと購読が失われたまま映像が来ない。
    for (const text of this.pendingUpstream) {
      this.counters = { ...this.counters, upstreamTextOut: this.counters.upstreamTextOut + 1 };
      link.value.sendText(text);
    }
    this.pendingUpstream = [];
    // **張り直しのたびに望む集合を送り直す**（F-056）。
    //
    // 中継ノードは接続が切れた購読を捨てる。受信ノードの側は「購読済み」のままなので、
    // 送り直さないと食い違いが固定され、その参加者の映像は永久に来ない。集合は
    // 冪等であるから、余分に送っても害はない。
    this.resyncUpstream();
  }

  /** 部屋名の先頭から役割を読む。 */
  private roleOfRoom(): ReceiveRole {
    return this.room.id.startsWith("ar-") ? "ar" : "vr";
  }

  /**
   * 購読した接続だけを回す。1 本も購読していなければ何もしない。
   *
   * 媒体は購読の結果として流れるものであり、購読していない接続へ送る理由が無い。
   */
  private eachSubscribedClient(action: (connection: Party.Connection) => void): void {
    // **1 本も購読の記録が無ければ全接続へ送る。** 再接続の直後など、購読を送り直す前の
    // 期間に媒体を止めてはならない。二重配送より欠落のほうが害が大きい。
    const alive = [...this.subscribedClients].filter((id) => this.clients.has(id));
    if (alive.length === 0) {
      this.eachClient(action);
      return;
    }
    for (const id of alive) {
      if (!this.clients.has(id)) {
        continue;
      }
      const connection = this.room.getConnection(id);
      if (connection !== undefined && connection !== null) {
        action(connection);
      }
    }
  }

  private eachClient(action: (connection: Party.Connection) => void): void {
    for (const id of this.clients) {
      const connection = this.room.getConnection(id);
      if (connection !== undefined && connection !== null) {
        action(connection);
      }
    }
  }
}

export default ReceiverNode;
