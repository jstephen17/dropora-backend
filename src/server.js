
import express from "express";
import cors from "cors";
import "dotenv/config";

import authRoutes from "./routes/auth.routes.js";
import lockerRoutes from "./routes/locker.routes.js";


import { supabase } from "./config/supabase.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "100kb" }));

// Connection check
app.get("/", (req, res) => {
    res.json({
        message: "Dropora API is running",
        status: "OK"
    });
});

// Health check
app.get("/health", async (req, res) => {
    try {
        const { error } = await supabase
            .from("profiles")
            .select("id")
            .limit(1);

        if (error) {
            throw error;
        }

        res.status(200).json({
            status: "HEALTHY",
            services: {
                server: "ONLINE",
                supabase: "CONNECTED",
                database: "ACCESSIBLE"
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error("Health check failed:", error.message);

        res.status(503).json({
            status: "UNHEALTHY",
            services: {
                server: "ONLINE",
                supabase: "UNAVAILABLE"
            },
            timestamp: new Date().toISOString()
        });
    }
});

// Routes
app.use("/api/auth", authRoutes);

app.use("/api/locker", lockerRoutes);

// Start server
app.listen(PORT, () => {
    console.log(`Dropora API running on port ${PORT}`);
});
