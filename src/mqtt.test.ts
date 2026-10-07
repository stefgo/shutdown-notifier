import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MqttError, parseMqttUrl, publishMqtt, type MqttConnection, type MqttMessage } from "./mqtt.js";

const CONNACK_OK = Buffer.from([0x20, 2, 0, 0]);
const PUBACK = Buffer.from([0x40, 2, 0, 1]);

const MESSAGE: MqttMessage = { topic: "a/b", payload: "hi", qos: 1, retain: false };

const servers: net.Server[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.close();
});

/**
 * A broker that gives the answers listed, one per chunk it receives -- an answer may be several
 * pieces, written one by one. Resolves to its URL and everything it was sent.
 */
async function broker(answers: (Buffer | Buffer[] | null)[]) {
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
        socket.on("error", () => {});
        socket.on("data", (chunk) => {
            received.push(chunk);
            const answer = answers.shift();
            for (const piece of Array.isArray(answer) ? answer : answer ? [answer] : []) socket.write(piece);
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, sent: () => Buffer.concat(received) };
}

function connection(url: string, over: Partial<MqttConnection> = {}): MqttConnection {
    return { url, clientId: "c", username: null, password: null, timeoutMs: 1_000, ...over };
}

describe("parseMqttUrl", () => {
    it("reads the host, the port and whether TLS is used", () => {
        expect(parseMqttUrl("mqtt://broker")).toEqual({ host: "broker", port: 1883, secure: false });
        expect(parseMqttUrl("mqtts://broker")).toEqual({ host: "broker", port: 8883, secure: true });
        expect(parseMqttUrl("mqtt://[::1]:1884")).toEqual({ host: "::1", port: 1884, secure: false });
    });

    it("refuses what is no broker", () => {
        expect(() => parseMqttUrl("broker")).toThrow(/is not a URL/);
        expect(() => parseMqttUrl("https://broker")).toThrow(/mqtt:\/\/ or mqtts:\/\//);
        expect(() => parseMqttUrl("mqtt://user:secret@broker")).toThrow(/SHUTDOWN_MQTT_USERNAME/);
    });
});

describe("publishMqtt", () => {
    it("connects, publishes and disconnects", async () => {
        const { url, sent } = await broker([CONNACK_OK, PUBACK]);
        await publishMqtt(connection(url), MESSAGE);
        await expect.poll(() => sent().toString("hex")).toBe(
            [
                "100d" + "00044d515454" + "04" + "02" + "0000" + "000163", // CONNECT, clean session, client id "c"
                "3209" + "0003612f62" + "0001" + "6869", // PUBLISH at QoS 1 to a/b, packet id 1, "hi"
                "e000", // DISCONNECT
            ].join(""),
        );
    });

    it("hands over the user name and the password", async () => {
        const { url, sent } = await broker([CONNACK_OK, PUBACK]);
        await publishMqtt(connection(url, { username: "u", password: "p" }), MESSAGE);
        expect(sent().subarray(0, 21).toString("hex")).toBe(
            "1013" + "00044d515454" + "04" + "c2" + "0000" + "000163" + "000175" + "000170",
        );
    });

    it("does not wait for an acknowledgement at QoS 0, and marks a message to be retained", async () => {
        const { url, sent } = await broker([CONNACK_OK]);
        await publishMqtt(connection(url), { ...MESSAGE, qos: 0, retain: true });
        await expect.poll(() => sent().subarray(15).toString("hex")).toBe("3107" + "0003612f62" + "6869" + "e000");
    });

    it("reads an answer that arrives in pieces", async () => {
        const { url } = await broker([[CONNACK_OK.subarray(0, 1), CONNACK_OK.subarray(1)], PUBACK]);
        await expect(publishMqtt(connection(url), MESSAGE)).resolves.toBeUndefined();
    });

    it("writes the length of a large message in several bytes", async () => {
        const { url, sent } = await broker([CONNACK_OK, PUBACK, null, null, null]);
        await publishMqtt(connection(url), { ...MESSAGE, payload: "x".repeat(200) });
        // 5 bytes of topic, 2 of packet id and 200 of payload are 207: 0xcf 0x01.
        await expect.poll(() => sent().subarray(15, 18).toString("hex")).toBe("32cf01");
    });

    it("says why the broker refused, and does not ask for another try", async () => {
        const { url } = await broker([Buffer.from([0x20, 2, 0, 5])]);
        const error = await publishMqtt(connection(url), MESSAGE).catch((err: MqttError) => err);
        expect(error).toMatchObject({ message: "The broker refused the connection: not authorised", retryable: false });
    });

    it("asks for another try when the broker is unavailable, does not answer or is not there", async () => {
        const unavailable = await broker([Buffer.from([0x20, 2, 0, 3])]);
        await expect(publishMqtt(connection(unavailable.url), MESSAGE)).rejects.toMatchObject({ retryable: true });

        const silent = await broker([]);
        await expect(publishMqtt(connection(silent.url, { timeoutMs: 50 }), MESSAGE)).rejects.toMatchObject({
            message: "No answer within 50 ms",
            retryable: true,
        });

        const gone = await broker([]);
        servers.pop()?.close();
        await expect(publishMqtt(connection(gone.url), MESSAGE)).rejects.toMatchObject({ retryable: true });
    });
});
