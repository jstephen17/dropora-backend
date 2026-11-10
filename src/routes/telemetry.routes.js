
import express from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { authenticate } from "../middleware/authenticate.js";

const router = express.Router();

// RECEIVE LOCKER TELEMETRY
router.post("/", async (req, res) => {
    try {
        const { device_uuid, recorded_at, payload } = req.body;

        // Validate required fields
        if (!device_uuid || !recorded_at || payload === undefined) {
            return res.status(400).json({
                error: "Device UUID, recorded_at, and payload are required"
            });
        }

        // Validate device UUID
        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(device_uuid)) {
            return res.status(400).json({
                error: "Invalid device UUID"
            });
        }

        // Validate timestamp
        if (
            typeof recorded_at !== "string" ||
            !Number.isFinite(Date.parse(recorded_at))
        ) {
            return res.status(400).json({
                error: "Invalid recorded_at timestamp"
            });
        }

        // Validate JSON payload
        if (
            payload === null ||
            typeof payload !== "object" ||
            Array.isArray(payload)
        ) {
            return res.status(400).json({
                error: "Payload must be a JSON object"
            });
        }

        // Find registered locker
        const { data: locker, error: lockerError } =
            await supabaseAdmin
                .from("lockers")
                .select("id, owner_id")
                .eq("device_uuid", device_uuid)
                .maybeSingle();

        if (lockerError) {
            console.error("Telemetry locker lookup error:", lockerError);

            return res.status(500).json({
                error: "Unable to verify locker"
            });
        }

        if (!locker) {
            return res.status(404).json({
                error: "Locker is not registered"
            });
        }

        // Check whether locker is paired
        if (!locker.owner_id) {
            return res.status(403).json({
                error: "Locker is not paired with an account"
            });
        }

        // Insert telemetry record
        const { data: telemetry, error: telemetryError } =
            await supabaseAdmin
                .from("locker_telemetry")
                .insert({
                    locker_id: locker.id,
                    recorded_at: new Date(recorded_at).toISOString(),
                    payload
                })
                .select("id, locker_id, recorded_at, received_at, payload")
                .single();

        if (telemetryError) {
            console.error("Telemetry insertion error:", telemetryError);

            return res.status(500).json({
                error: "Unable to save telemetry"
            });
        }

        return res.status(201).json({
            message: "Telemetry received successfully",
            telemetry
        });

    } catch (error) {
        console.error("Telemetry endpoint error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

// GET LOCKER TELEMETRY WITH PAGINATION
router.get("/:deviceUuid", authenticate, async (req, res) => {
    try {
        const { deviceUuid } = req.params;

        const offset = Number(req.query.offset ?? 0);
        const limit = Number(req.query.limit ?? 10);

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(deviceUuid)) {
            return res.status(400).json({
                error: "Invalid device UUID"
            });
        }

        if (
            !Number.isInteger(offset) ||
            offset < 0 ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100
        ) {
            return res.status(400).json({
                error: "Invalid pagination parameters"
            });
        }

        // Find locker and verify ownership through RLS
        const { data: locker, error: lockerError } =
            await req.supabase
                .from("lockers")
                .select("id, device_uuid")
                .eq("device_uuid", deviceUuid)
                .maybeSingle();

        if (lockerError) {
            console.error("Locker lookup error:", lockerError);

            return res.status(500).json({
                error: "Unable to retrieve locker"
            });
        }

        if (!locker) {
            return res.status(404).json({
                error: "Locker not found or access denied"
            });
        }

        // Fetch telemetry using the internal locker ID
        const { data: telemetry, error: telemetryError, count } =
            await req.supabase
                .from("locker_telemetry")
                .select(
                    "id, locker_id, recorded_at, received_at, payload",
                    { count: "exact" }
                )
                .eq("locker_id", locker.id)
                .order("recorded_at", { ascending: false })
                .order("id", { ascending: false })
                .range(offset, offset + limit - 1);

        if (telemetryError) {
            console.error("Telemetry retrieval error:", telemetryError);

            return res.status(500).json({
                error: "Unable to retrieve telemetry"
            });
        }

        const total = count ?? 0;
        const hasMore = offset + telemetry.length < total;

        return res.status(200).json({
            message: "Telemetry retrieved successfully",
            locker: {
                id: locker.id,
                device_uuid: locker.device_uuid
            },
            pagination: {
                offset,
                limit,
                total,
                returned: telemetry.length,
                has_more: hasMore,
                next_offset: hasMore
                    ? offset + telemetry.length
                    : null
            },
            telemetry
        });

    } catch (error) {
        console.error("Telemetry retrieval endpoint error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

export default router;
