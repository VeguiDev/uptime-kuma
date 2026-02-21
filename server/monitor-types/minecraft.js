const { MonitorType } = require("./monitor-type");
const { UP } = require("../../src/util");
const mcs = require("node-mcstatus");

class MinecraftMonitorType extends MonitorType {
    name = "minecraft";

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const subtype = monitor.subtype === "bedrock" ? "bedrock" : "java";
        const port = monitor.port || (subtype === "bedrock" ? 19132 : 25565);

        let result;

        try {
            if (subtype === "bedrock") {
                result = await mcs.statusBedrock(monitor.hostname, port);
            } else {
                result = await mcs.statusJava(monitor.hostname, port, { query: true });
            }
        } catch (error) {
            throw new Error(`Minecraft check failed: ${error.message}`);
        }

        if (!result?.online) {
            throw new Error("Minecraft server is offline");
        }

        const messageParts = [];
        const version = result?.version?.name_clean || result?.version?.name || result?.version;
        const playersOnline = result?.players?.online;
        const playersMax = result?.players?.max;
        const motd = this.getMOTD(result);

        if (version) {
            messageParts.push(`Version: ${version}`);
        }

        if (Number.isFinite(playersOnline) && Number.isFinite(playersMax)) {
            messageParts.push(`Players: ${playersOnline}/${playersMax}`);
        }

        if (motd) {
            messageParts.push(`MOTD: ${motd}`);
        }

        if (Number.isFinite(result?.latency)) {
            heartbeat.ping = result.latency;
        }

        heartbeat.msg = messageParts.join(" | ") || "Online";
        heartbeat.status = UP;
    }

    /**
     * Build a readable MOTD string from the API response.
     * @param {object} result status response from node-mcstatus
     * @returns {string} A flattened MOTD string for heartbeat message output.
     */
    getMOTD(result) {
        const motd = result?.motd;
        if (!motd) {
            return "";
        }

        if (typeof motd === "string") {
            return motd.trim();
        }

        if (typeof motd?.clean === "string") {
            return motd.clean.trim();
        }

        if (Array.isArray(motd?.clean)) {
            return motd.clean.join(" ").trim();
        }

        if (typeof motd?.raw === "string") {
            return motd.raw.trim();
        }

        return "";
    }
}

module.exports = {
    MinecraftMonitorType,
};
