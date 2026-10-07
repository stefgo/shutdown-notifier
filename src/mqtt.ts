/**
 * Just enough of MQTT 3.1.1 to publish one message: connect, publish, disconnect.
 *
 * The notifier reports a handful of events a year, so it keeps no connection open -- and with
 * no connection to keep there is no keep-alive, no reconnect and no subscription to speak. What
 * is left of the protocol fits here, and the image stays without a runtime dependency.
 */
import net from "node:net";
import tls from "node:tls";

export interface MqttTarget {
    host: string;
    port: number;
    /** `mqtts://`: the connection is wrapped in TLS. */
    secure: boolean;
}

export interface MqttConnection {
    url: string;
    clientId: string;
    username: string | null;
    password: string | null;
    /** How long the whole exchange may take. */
    timeoutMs: number;
}

export interface MqttMessage {
    topic: string;
    payload: string;
    /** 1 waits for the broker to acknowledge the message. */
    qos: 0 | 1;
    retain: boolean;
}

export class MqttError extends Error {
    constructor(
        message: string,
        /** Worth another try: the broker could not be reached, or said it is unavailable. */
        readonly retryable: boolean,
    ) {
        super(message);
        this.name = "MqttError";
    }
}

const CONNACK = 2;
const PUBACK = 4;

/** Only one message is published per connection, so one id is all there is. */
const PACKET_ID = 1;

/** Why a broker refused the connection, by the return code of its CONNACK. */
const REFUSALS: Record<number, string> = {
    1: "it does not speak MQTT 3.1.1",
    2: "it rejected the client id",
    3: "it is unavailable",
    4: "bad user name or password",
    5: "not authorised",
};

/** Takes `mqtt://host[:port]` and `mqtts://host[:port]`. Throws with a message meant for the operator. */
export function parseMqttUrl(url: string): MqttTarget {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`"${url}" is not a URL, such as mqtt://broker:1883`);
    }
    if (parsed.protocol !== "mqtt:" && parsed.protocol !== "mqtts:") {
        throw new Error(`starts with mqtt:// or mqtts://, not ${parsed.protocol}//`);
    }
    if (parsed.username || parsed.password) {
        throw new Error("takes no user name or password -- those are SHUTDOWN_MQTT_USERNAME and SHUTDOWN_MQTT_PASSWORD");
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (!host) throw new Error("names no host");
    const secure = parsed.protocol === "mqtts:";
    return { host, port: parsed.port ? Number(parsed.port) : secure ? 8883 : 1883, secure };
}

/** Text as MQTT writes it: two bytes of length, then UTF-8. */
function text(value: string): Buffer {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > 0xffff) throw new MqttError("A text of more than 65535 bytes does not fit into MQTT", false);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
}

/** A packet: the type and its flags, the length of the rest in 7-bit groups, the rest. */
function packet(header: number, ...parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts);
    const length: number[] = [];
    let rest = body.length;
    do {
        const group = rest % 128;
        rest = Math.floor(rest / 128);
        length.push(rest > 0 ? group | 0x80 : group);
    } while (rest > 0);
    if (length.length > 4) throw new MqttError("The message is larger than MQTT allows", false);
    return Buffer.concat([Buffer.from([header, ...length]), body]);
}

function connectPacket(connection: MqttConnection): Buffer {
    let flags = 0x02; // A clean session: nothing is to be kept for a client that never comes back.
    const payload = [text(connection.clientId)];
    if (connection.username !== null) {
        flags |= 0x80;
        payload.push(text(connection.username));
        if (connection.password !== null) {
            flags |= 0x40;
            payload.push(text(connection.password));
        }
    }
    // Protocol level 4 is MQTT 3.1.1; a keep-alive of 0 turns the keep-alive off.
    return packet(0x10, text("MQTT"), Buffer.from([4, flags, 0, 0]), ...payload);
}

function publishPacket(message: MqttMessage): Buffer {
    const id = message.qos > 0 ? [Buffer.from([PACKET_ID >> 8, PACKET_ID & 0xff])] : [];
    return packet(
        0x30 | (message.qos << 1) | (message.retain ? 1 : 0),
        text(message.topic),
        ...id,
        Buffer.from(message.payload, "utf8"),
    );
}

const DISCONNECT = Buffer.from([0xe0, 0]);

/**
 * Takes the first complete packet off the front of what was received. Null when the rest of it
 * is still on its way -- TCP delivers a packet in as many pieces as it likes.
 */
function takePacket(received: Buffer): { type: number; body: Buffer; rest: Buffer } | null {
    let length = 0;
    for (let i = 1; ; i++) {
        if (i >= received.length) return null;
        if (i > 4) throw new MqttError("The answer is not MQTT", false);
        length += (received[i] & 0x7f) * 128 ** (i - 1);
        if ((received[i] & 0x80) === 0) {
            const end = i + 1 + length;
            if (received.length < end) return null;
            return { type: received[0] >> 4, body: received.subarray(i + 1, end), rest: received.subarray(end) };
        }
    }
}

/** Connects, publishes the one message and disconnects. Rejects with an `MqttError`. */
export function publishMqtt(connection: MqttConnection, message: MqttMessage): Promise<void> {
    return new Promise((resolve, reject) => {
        const target = parseMqttUrl(connection.url);
        const connect = connectPacket(connection);
        const publish = publishPacket(message);

        const socket = target.secure
            ? tls.connect({ host: target.host, port: target.port })
            : net.connect({ host: target.host, port: target.port });
        let received: Buffer = Buffer.alloc(0);
        let ended = false;

        const end = (error?: MqttError): void => {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(
            () => end(new MqttError(`No answer within ${connection.timeoutMs} ms`, true)),
            connection.timeoutMs,
        );
        /** Says goodbye and ends once that is written, so the broker does not see a dropped client. */
        const leave = (): void => {
            socket.end(DISCONNECT, () => end());
        };

        const handle = (type: number, body: Buffer): void => {
            if (type === CONNACK) {
                const code = body[1] ?? -1;
                if (code !== 0) {
                    const reason = REFUSALS[code] ?? `return code ${code}`;
                    return end(new MqttError(`The broker refused the connection: ${reason}`, code === 3));
                }
                socket.write(publish);
                // Without an acknowledgement to wait for, the message is handed over and that is it.
                if (message.qos === 0) leave();
            } else if (type === PUBACK && body.length >= 2 && body.readUInt16BE(0) === PACKET_ID) {
                leave();
            }
        };

        socket.once(target.secure ? "secureConnect" : "connect", () => socket.write(connect));
        socket.on("data", (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
            try {
                for (let next = takePacket(received); next && !ended; next = takePacket(received)) {
                    received = next.rest;
                    handle(next.type, next.body);
                }
            } catch (err) {
                end(err as MqttError);
            }
        });
        socket.on("error", (err: Error & { code?: string; errors?: Error[] }) => {
            // A refused connection to a name with several addresses is an AggregateError whose
            // own message is empty.
            end(new MqttError(err.message || err.errors?.[0]?.message || err.code || "Connection failed", true));
        });
        socket.on("close", () => end(new MqttError("The broker closed the connection", true)));
    });
}
