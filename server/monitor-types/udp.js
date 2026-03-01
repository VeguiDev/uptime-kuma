const { lookup } = require("node:dns/promises");
const dgram = require("node:dgram");
const { MonitorType } = require("./monitor-type");
const { UP, PING_GLOBAL_TIMEOUT_DEFAULT: TIMEOUT } = require("../../src/util");

class UDPMonitorType extends MonitorType {
    name = "udp";

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        try {
            const responseTime = await this.udpPing(monitor);
            heartbeat.ping = responseTime;
            heartbeat.msg = `${responseTime} ms`;
            heartbeat.status = UP;
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            throw new Error(`Connection failed: ${message}`);
        }
    }

    /**
     * Checks UDP reachability by sending a datagram and waiting for either:
     * - an ICMP error (socket error => DOWN), or
     * - a response packet, or
     * - timeout (treated as reachable/open|filtered)
     * @param {object} monitor Monitor object
     * @returns {Promise<number>} Response time in ms
     */
    async udpPing(monitor) {
        if (!Number.isInteger(monitor.port) || monitor.port < 0 || monitor.port > 65535) {
            throw new Error("Invalid port");
        }

        const timeoutSeconds =
            Number.isFinite(monitor.timeout) && Number(monitor.timeout) > 0 ? Number(monitor.timeout) : TIMEOUT;
        const timeoutMs = Math.round(timeoutSeconds * 1000);

        const lookupOptions = {};
        if (monitor.ipFamily === "ipv4") {
            lookupOptions.family = 4;
        } else if (monitor.ipFamily === "ipv6") {
            lookupOptions.family = 6;
        }

        const resolved = await lookup(monitor.hostname, lookupOptions);
        const socketType = resolved.family === 6 ? "udp6" : "udp4";

        return await new Promise((resolve, reject) => {
            const socket = dgram.createSocket(socketType);
            const start = Date.now();
            let timeoutID;
            let settled = false;

            const finish = (handler, value) => {
                if (settled) {
                    return;
                }

                settled = true;
                if (timeoutID) {
                    clearTimeout(timeoutID);
                }

                socket.removeAllListeners();
                socket.close(() => handler(value));
            };

            socket.once("error", (error) => {
                finish(reject, error);
            });

            socket.once("message", () => {
                finish(resolve, Math.round(Date.now() - start));
            });

            socket.connect(monitor.port, resolved.address, (connectError) => {
                if (connectError) {
                    finish(reject, connectError);
                    return;
                }

                socket.send(Buffer.from([0x00]), (sendError) => {
                    if (sendError) {
                        finish(reject, sendError);
                        return;
                    }

                    timeoutID = setTimeout(() => {
                        // UDP has no handshake; without explicit ICMP errors, treat as reachable.
                        finish(resolve, Math.round(Date.now() - start));
                    }, timeoutMs);
                });
            });
        });
    }
}

module.exports = {
    UDPMonitorType,
};
