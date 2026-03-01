const { describe, test } = require("node:test");
const assert = require("node:assert");
const dgram = require("node:dgram");
const { UDPMonitorType } = require("../../../server/monitor-types/udp");
const { UP, PENDING } = require("../../../src/util");

/**
 * Creates a UDP echo server on localhost and a random free port.
 * @returns {Promise<{ server: dgram.Socket, port: number }>} Server and assigned port
 */
async function createUdpEchoServer() {
    return await new Promise((resolve, reject) => {
        const server = dgram.createSocket("udp4");

        server.once("error", (error) => {
            reject(error);
        });

        server.on("message", (_message, remoteInfo) => {
            server.send(Buffer.from([0x01]), remoteInfo.port, remoteInfo.address);
        });

        server.bind(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({
                server,
                port: address.port,
            });
        });
    });
}

/**
 * Closes a UDP socket and waits until close callback is executed.
 * @param {dgram.Socket} socket Socket to close
 * @returns {Promise<void>}
 */
async function closeSocket(socket) {
    await new Promise((resolve) => {
        socket.close(resolve);
    });
}

describe("UDP Monitor", () => {
    test("check() sets status to UP when UDP endpoint is reachable", async () => {
        const { server, port } = await createUdpEchoServer();

        try {
            const udpMonitor = new UDPMonitorType();

            const monitor = {
                hostname: "127.0.0.1",
                port,
                timeout: 2,
                ipFamily: "ipv4",
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            await udpMonitor.check(monitor, heartbeat, {});

            assert.strictEqual(heartbeat.status, UP);
            assert.strictEqual(typeof heartbeat.ping, "number");
        } finally {
            await closeSocket(server);
        }
    });

    test("check() rejects when hostname cannot be resolved", async () => {
        const udpMonitor = new UDPMonitorType();

        const monitor = {
            hostname: "definitely-invalid-hostname.uptime-kuma.invalid",
            port: 53,
            timeout: 1,
        };

        const heartbeat = {
            msg: "",
            status: PENDING,
        };

        await assert.rejects(udpMonitor.check(monitor, heartbeat, {}), /Connection failed:/);
    });
});
