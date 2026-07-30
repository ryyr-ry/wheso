/**
 * ノード間接続（Durable Object → Durable Object）。
 *
 * 規範: wire-format.md 2.8（nodeHello / nodeHelloAck）、auth.md 4 節（ノード間 HMAC）、
 *       state-machines.md 4 節（ノード間ツリー）、room-naming.md（割当の解決）。
 * 根拠: 事実台帳 F-016（`stub.socket()` で成立。確立 438 ms。実測）。
 *
 * **なぜこのファイルが必要か。** 段 F まで、ノード間の接続は 1 本も存在しなかった。
 * 送信ノードの `connectShard` は「意図を記録してクライアントへ通知する」だけであり、
 * 受信ノードの `sendUpstream` は「`role=upstream` と名乗って繋いできた接続」へ送っていた。
 * その接続を張る側が居ないため、受信ノードへ媒体は 1 度も届かず、`ack` も 1 度も出なかった。
 * すなわち中継ノードの送信窓（ADR-0025）は製品経路で 1 度も動いていなかった。
 *
 * **接続の向きは常に「個人ノード → 中継ノード」である。** 中継ノードは自分から繋がない。
 * 理由は 2 つある。第 1 に、中継ノードは誰が参加しているかを知らない（割当は部屋名から
 * 決まる）。第 2 に、疎通試験と E2E が既にこの向きで組まれており、実環境で成立している
 * （疎通試験の手引き）。
 *
 * **アラームからこの関数を呼んではならない。** PartyKit の `onAlarm` は
 * `room.id` と `room.context.parties` へ触れると実行時に失敗する（`partykit/server.d.ts`）。
 * 接続は `onMessage` / `onConnect` の文脈で確立する。
 */

import type * as Party from "partykit/server";

import { deriveMeetingSecret, nodeAuthTag, nodeAuthTimeWindow } from "@wheso/core/src/auth.ts";
import { NODE_CONNECT_TIMEOUT_MS } from "@wheso/core/src/generated/constants.ts";
import { type Result, err, ok } from "@wheso/core/src/result.ts";
import { parseNodeHelloAck } from "./node-auth.ts";

/** 上流へ名乗る役割。中継ノードが authTag の計算に使う。 */
export type NodeLinkRole = "sender" | "receiver" | "coordinator";

/**
 * `stub.socket()` が返すソケットの型。
 *
 * 実行環境（Cloudflare Workers）の `WebSocket` は DOM の同名型と別物である。型注釈に
 * DOM の `WebSocket` を書くと型検査が通らない。**どちらかへ寄せるために型アサーションを
 * 使ってはならない。** 実行環境の定義から導く。
 */
type NodeSocket = Awaited<ReturnType<Party.Stub["socket"]>>;

/** WebSocket API が定める「確立済み」の状態値。プロジェクトの調整値ではない。 */
const SOCKET_STATE_OPEN = 1;

export interface NodeLinkError {
  readonly code: string;
  readonly detail: string;
}

/** 確立した 1 本のノード間接続。 */
export interface NodeLink {
  /** 相手の部屋名。 */
  readonly targetRoom: string;
  /** 制御メッセージを送る。未確立の間は溜める。 */
  readonly sendText: (text: string) => void;
  /**
   * 媒体を送る。
   *
   * **`nodeHelloAck` を受ける前は捨てる。** 中継ノードは認証前のメディアを破棄するため
   * （wire-format.md 2.8）、溜めて送っても相手に捨てられる。溜め続けると記憶を食う。
   */
  readonly sendBinary: (bytes: Uint8Array) => void;
  readonly close: () => void;
  /** `nodeHelloAck` を受けたか。 */
  readonly isReady: () => boolean;
  /** 捨てた媒体の数。観測のために数える。 */
  readonly droppedBeforeReady: () => number;
}

export interface OpenNodeLinkOptions {
  /** 自分の部屋。`context.parties` を得るために使う。 */
  readonly room: Party.Room;
  /** 相手の party 名（`partykit.json` の `parties` の鍵）。 */
  readonly party: string;
  /** 相手の部屋名。authTag はこの名前に対して作る。 */
  readonly targetRoom: string;
  /** 相手の部屋名から取り出した会議 ID。 */
  readonly meetingId: string;
  readonly role: NodeLinkRole;
  /** ノード間認証の鍵（環境変数から入口が渡す）。 */
  readonly nodeKey: string;
  readonly nowMs: number;
  /** 相手からの制御メッセージ。 */
  readonly onText: (text: string) => void;
  /** 相手からの媒体。 */
  readonly onBinary: (bytes: Uint8Array) => void;
  /** 接続が閉じた。呼び出し側は記録を捨てて必要なら張り直す。 */
  readonly onClose: () => void;
  /** 確立の段階を伝える（観測のため）。 */
  readonly onStage?: ((stage: string) => void) | undefined;
}

/**
 * `nodeHello` の本文を作る。
 *
 * 算出は `auth.ts` の参照実装に委ねる。**ここで文字列を組み立て直してはならない。**
 * 区切りを 1 文字間違えるとクローズコード 4023 で切られる（実際に起きた。疎通試験の手引き）。
 */
export async function buildNodeHello(
  nodeKey: string,
  meetingId: string,
  targetRoom: string,
  role: NodeLinkRole,
  nowMs: number,
  selfRoom: string,
): Promise<Result<string, NodeLinkError>> {
  if (nodeKey.length === 0) {
    return err({ code: "E_NODE_AUTH", detail: "node key missing" });
  }
  const secret = await deriveMeetingSecret(new TextEncoder().encode(nodeKey), meetingId);
  if (!secret.ok) {
    return err({ code: secret.error.code, detail: secret.error.detail });
  }
  const window = nodeAuthTimeWindow(Math.trunc(nowMs / 1000));
  const tag = await nodeAuthTag(secret.value, targetRoom, role, window);
  if (!tag.ok) {
    return err({ code: tag.error.code, detail: tag.error.detail });
  }
  // **`nodeId` は自分の部屋名である。** 相手はこれから参加者 ID を導き、転送の宛先にする
  // （`vr-<会議 ID>-<利用者 ID>` の利用者 ID を `fnv1a32` にかけた値。クライアントの
  // `senderIdOf` と同じ算出である）。相手の部屋名を入れると宛先が決まらない。
  return ok(JSON.stringify({ t: "nodeHello", role, nodeId: selfRoom, authTag: tag.value }));
}

/**
 * ノード間接続を開く。
 *
 * 手順:
 *   1. 相手の party の stub を得る（`room.context.parties[party].get(targetRoom)`）
 *   2. `socket()` で WebSocket を得る（F-016 でこの経路が成立することを確認済み）
 *   3. `nodeHello` を送る
 *   4. `nodeHelloAck` を受けたら媒体の送出を許す
 *
 * 失敗は Result で返す。例外を投げない。
 */
export async function openNodeLink(options: OpenNodeLinkOptions): Promise<Result<NodeLink, NodeLinkError>> {
  options.onStage?.("名前空間を引く");
  const namespace = options.room.context.parties[options.party];
  if (namespace === undefined) {
    return err({ code: "E_NODE_LINK", detail: `party ${options.party} が無い` });
  }
  options.onStage?.("nodeHello を作る");
  const hello = await buildNodeHello(
    options.nodeKey,
    options.meetingId,
    options.targetRoom,
    options.role,
    options.nowMs,
    options.room.id,
  );
  if (!hello.ok) {
    return err(hello.error);
  }

  options.onStage?.("socket を開く");
  let socket: NodeSocket;
  try {
    // **時限を切る**（`NODE_CONNECT_TIMEOUT_MS`。timeouts の規範）。
    // 切らないと、相手のノードが応じない場合に `onMessage` が永久に返らず、
    // 以後その部屋は何も処理しなくなる（実測: 受信ノードが購読を上流へ渡せなくなった）。
    const connected = await Promise.race([
      namespace.get(options.targetRoom).socket(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), NODE_CONNECT_TIMEOUT_MS);
      }),
    ]);
    if (connected === null) {
      return err({ code: "E_NODE_LINK", detail: "socket() が時限内に確立しなかった" });
    }
    socket = connected;
    options.onStage?.("socket が確立した");
  } catch (error) {
    return err({
      code: "E_NODE_LINK",
      detail: error instanceof Error ? `${error.name}: ${error.message}` : "socket() が失敗した",
    });
  }

  let ready = false;
  let dropped = 0;
  const pendingText: string[] = [];
  let open = socket.readyState === SOCKET_STATE_OPEN;

  const flush = (): void => {
    for (const text of pendingText) {
      socket.send(text);
    }
    pendingText.length = 0;
  };

  socket.addEventListener("open", () => {
    open = true;
    socket.send(hello.value);
    flush();
  });
  socket.addEventListener("close", () => {
    open = false;
    ready = false;
    options.onClose();
  });
  socket.addEventListener("error", () => {
    // `error` の直後に必ず `close` が来る。二重に伝えない。
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      // 形式検査を通す。`t` だけを見ると壊れた本文を受理してしまう。
      if (parseNodeHelloAck(event.data).ok) {
        // 受理された。以後は媒体を送ってよい（state-machines.md 4 節）。
        ready = true;
        return;
      }
      options.onText(event.data);
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      options.onBinary(new Uint8Array(event.data));
    }
  });

  if (open) {
    // `socket()` は確立済みの WebSocket を返すことがある（F-016 の実測ではその形だった）。
    // その場合 `open` 事象は発火しないため、ここで送る。
    socket.send(hello.value);
  }

  return ok({
    targetRoom: options.targetRoom,
    sendText: (text): void => {
      if (!open) {
        pendingText.push(text);
        return;
      }
      socket.send(text);
    },
    sendBinary: (bytes): void => {
      if (!open || !ready) {
        dropped += 1;
        return;
      }
      socket.send(bytes);
    },
    close: (): void => {
      socket.close();
    },
    isReady: (): boolean => ready,
    droppedBeforeReady: (): number => dropped,
  });
}

