<template>
    <div>
        <StatusPage v-if="statusPageSlug" :override-slug="statusPageSlug" />
    </div>
</template>

<script>
import axios from "axios";
import StatusPage from "./StatusPage.vue";

export default {
    components: {
        StatusPage,
    },
    data() {
        return {
            statusPageSlug: null,
        };
    },
    async mounted() {
        // There are 4 cases:
        // 1. Matched status Page by domain or domain/path
        // 2. Entry page routing (dashboard or status page)
        // 3. Setup database route
        // 4. Unknown route -> not found
        let res;
        try {
            const pathname = window.location.pathname || "/";
            res = (
                await axios.get("/api/entry-page", {
                    params: {
                        pathname,
                    },
                })
            ).data;

            if (res.type === "statusPageMatchedDomain") {
                this.statusPageSlug = res.statusPageSlug;
                this.$root.forceStatusPageTheme = true;
            } else if (res.type === "entryPage") {
                if (pathname !== "/") {
                    this.$router.replace("/page-not-found");
                    return;
                }

                // Dev only. For production, the logic is in the server side
                const entryPage = res.entryPage;
                if (entryPage?.startsWith("statusPage-")) {
                    this.$router.push("/status/" + entryPage.replace("statusPage-", ""));
                } else {
                    // should the old setting style still exist here?
                    this.$router.push("/dashboard");
                }
            } else if (res.type === "setup-database") {
                this.$router.push("/setup-database");
            } else {
                if (pathname === "/") {
                    this.$router.push("/dashboard");
                } else {
                    this.$router.replace("/page-not-found");
                }
            }
        } catch (e) {
            alert("Cannot connect to the backend server. Did you start the backend server? (npm run start-server-dev)");
        }
    },
};
</script>
