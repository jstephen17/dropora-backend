
import express from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { authenticate } from "../middleware/authenticate.js";

const router = express.Router();


// RECEIVE LOCKER TELEMETRY
router.post("/", async (req, res) => {
    try {
        const {
            device_uuid,
            recorded_at,
            payload,
            request_id
        } = req.body;

        // Validate required fields
        if (!device_uuid || payload === undefined) {
            return res.status(400).json({
                error: "Device UUID and payload are required"
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

        // Validate optional timestamp
        let normalizedTimestamp = null;

        if (
            recorded_at !== undefined &&
            recorded_at !== null &&
            recorded_at !== ""
        ) {
            if (
                typeof recorded_at !== "string" ||
                !Number.isFinite(Date.parse(recorded_at))
            ) {
                return res.status(400).json({
                    error: "Invalid recorded_at timestamp"
                });
            }

            normalizedTimestamp =
                new Date(recorded_at).toISOString();
        }

        // Validate payload
        if (
            payload === null ||
            typeof payload !== "object" ||
            Array.isArray(payload)
        ) {
            return res.status(400).json({
                error: "Payload must be a JSON object"
            });
        }

        // Validate optional request ID
        let normalizedRequestId = null;

        if (
            request_id !== undefined &&
            request_id !== null &&
            request_id !== ""
        ) {
            normalizedRequestId = Number(request_id);

            if (
                !Number.isSafeInteger(normalizedRequestId) ||
                normalizedRequestId < 1
            ) {
                return res.status(400).json({
                    error: "Invalid request_id"
                });
            }
        }

        // Atomically insert telemetry and fulfill request
        const { data, error } = await supabaseAdmin.rpc(
            "submit_locker_telemetry",
            {
                p_device_uuid: device_uuid,
                p_payload: payload,
                p_recorded_at: normalizedTimestamp,
                p_request_id: normalizedRequestId
            }
        );

        if (error) {
            console.error("Telemetry submission RPC error:", error);

            const message = error.message || "";

            if (message.includes("LOCKER_NOT_FOUND")) {
                return res.status(404).json({
                    error: "Locker is not registered"
                });
            }

            if (message.includes("LOCKER_NOT_PAIRED")) {
                return res.status(403).json({
                    error: "Locker is not paired with an account"
                });
            }

            if (message.includes("REQUEST_NOT_FOUND")) {
                return res.status(404).json({
                    error: "Telemetry request not found for this locker"
                });
            }

            if (message.includes("REQUEST_NOT_PENDING")) {
                return res.status(409).json({
                    error: "Telemetry request has already been fulfilled"
                });
            }

            if (message.includes("INVALID_PAYLOAD")) {
                return res.status(400).json({
                    error: "Payload must be a JSON object"
                });
            }

            return res.status(500).json({
                error: "Unable to save telemetry"
            });
        }

        return res.status(201).json({
            message: "Telemetry received successfully",
            telemetry: data.telemetry,
            request_fulfilled: data.request_fulfilled
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

// POST DOOR EVENT FROM A LOCKER DEVICE
router.post("/device/:deviceUuid/door-events", async (req, res) => {
    try {
        const { deviceUuid } = req.params;
        const { event_type, method, occurred_at } = req.body;

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(deviceUuid)) {
            return res.status(400).json({
                error: "Invalid device UUID"
            });
        }

        // 1. Validate event type
        const validEventTypes = ["opened", "closed"];

        if (!validEventTypes.includes(event_type)) {
            return res.status(400).json({
                error: "Invalid event type. Must be opened or closed."
            });
        }

        // 2. Validate access method
        const validMethods = ["rfid", "passcode", "remote"];

        if (!validMethods.includes(method)) {
            return res.status(400).json({
                error: "Invalid method. Must be rfid, passcode, or remote."
            });
        }

        // 3. Validate optional event timestamp
        if (
            occurred_at !== undefined &&
            (
                typeof occurred_at !== "string" ||
                Number.isNaN(Date.parse(occurred_at))
            )
        ) {
            return res.status(400).json({
                error: "Invalid event timestamp"
            });
        }

        // 4. Find the registered locker and verify pairing
        const { data: locker, error: lockerError } =
            await supabaseAdmin
                .from("lockers")
                .select("id, device_uuid, owner_id")
                .eq("device_uuid", deviceUuid)
                .maybeSingle();

        if (lockerError) {
            console.error("Locker lookup error:", lockerError);

            return res.status(500).json({
                error: "Unable to verify locker"
            });
        }

        if (!locker || !locker.owner_id) {
            return res.status(403).json({
                error: "Locker is not registered or paired"
            });
        }

        // 5. Insert the door event
        const eventData = {
            locker_id: locker.id,
            event_type,
            method
        };

        if (occurred_at !== undefined) {
            eventData.occurred_at = occurred_at;
        }

        const { data: doorEvent, error: insertError } =
            await supabaseAdmin
                .from("door_events")
                .insert(eventData)
                .select("id, locker_id, event_type, method, occurred_at, received_at")
                .single();

        if (insertError) {
            console.error("Door event insertion error:", insertError);

            return res.status(500).json({
                error: "Unable to record door event"
            });
        }

        // 6. Return the recorded event
        return res.status(201).json({
            message: "Door event recorded successfully",
            device_uuid: deviceUuid,
            event: doorEvent
        });

    } catch (error) {
        console.error("Door event endpoint error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

// GET LOCKER DOOR EVENTS WITH PAGINATION
router.get("/:deviceUuid/door-events", authenticate, async (req, res) => {
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

        // 1. Find locker and verify ownership through RLS
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

        // 2. Fetch door events using the internal locker ID
        const { data: doorEvents, error: eventError, count } =
            await req.supabase
                .from("door_events")
                .select(
                    "id, locker_id, event_type, method, occurred_at, received_at",
                    { count: "exact" }
                )
                .eq("locker_id", locker.id)
                .order("occurred_at", { ascending: false })
                .order("id", { ascending: false })
                .range(offset, offset + limit - 1);

        if (eventError) {
            console.error("Door event retrieval error:", eventError);

            return res.status(500).json({
                error: "Unable to retrieve door events"
            });
        }

        // 3. Calculate pagination information
        const total = count ?? 0;
        const hasMore = offset + doorEvents.length < total;

        // 4. Return door event history
        return res.status(200).json({
            message: "Door events retrieved successfully",
            locker: {
                id: locker.id,
                device_uuid: locker.device_uuid
            },
            pagination: {
                offset,
                limit,
                total,
                returned: doorEvents.length,
                has_more: hasMore,
                next_offset: hasMore
                    ? offset + doorEvents.length
                    : null
            },
            door_events: doorEvents
        });

    } catch (error) {
        console.error("Door event retrieval endpoint error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


// REQUEST FRESH TELEMETRY FROM A LOCKER
router.post("/:deviceUuid/request", authenticate, async (req, res) => {
    try {
        const { deviceUuid } = req.params;

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(deviceUuid)) {
            return res.status(400).json({
                error: "Invalid device UUID"
            });
        }

        // Verify locker ownership through authenticated client
        const { data: locker, error: lockerError } =
            await req.supabase
                .from("lockers")
                .select("id, device_uuid")
                .eq("device_uuid", deviceUuid)
                .maybeSingle();

        if (lockerError) {
            console.error("Telemetry request locker lookup error:", lockerError);

            return res.status(500).json({
                error: "Unable to verify locker"
            });
        }

        if (!locker) {
            return res.status(404).json({
                error: "Locker not found or access denied"
            });
        }

        // Reuse an existing pending request if one exists
        const { data: existingRequest, error: existingError } =
            await supabaseAdmin
                .from("telemetry_requests")
                .select("*")
                .eq("locker_id", locker.id)
                .eq("status", "pending")
                .order("requested_at", { ascending: true })
                .limit(1)
                .maybeSingle();

        if (existingError) {
            console.error("Pending telemetry request lookup error:", existingError);

            return res.status(500).json({
                error: "Unable to check existing telemetry requests"
            });
        }

        if (existingRequest) {
            return res.status(200).json({
                message: "A telemetry request is already pending",
                request: existingRequest,
                reused: true
            });
        }

        // Create a new request
        const { data: newRequest, error: insertError } =
            await supabaseAdmin
                .from("telemetry_requests")
                .insert({
                    locker_id: locker.id,
                    status: "pending"
                })
                .select("*")
                .single();

        if (insertError) {
            // Another frontend request may have inserted one
            // between our lookup and insert.
            if (insertError.code === "23505") {
                const { data: pendingRequest } =
                    await supabaseAdmin
                        .from("telemetry_requests")
                        .select("*")
                        .eq("locker_id", locker.id)
                        .eq("status", "pending")
                        .maybeSingle();

                if (pendingRequest) {
                    return res.status(200).json({
                        message: "A telemetry request is already pending",
                        request: pendingRequest,
                        reused: true
                    });
                }
            }

            console.error("Telemetry request insertion error:", insertError);

            return res.status(500).json({
                error: "Unable to create telemetry request"
            });
        }

        return res.status(202).json({
            message: "Telemetry request created successfully",
            request: newRequest,
            reused: false
        });

    } catch (error) {
        console.error("Telemetry request endpoint error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});



// CHECK FOR PENDING TELEMETRY REQUESTS (DEVICE)
router.get("/device/:deviceUuid/requests/pending", async (req, res) => {
    try {
        const { deviceUuid } = req.params;

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(deviceUuid)) {
            return res.status(400).json({
                error: "Invalid device UUID"
            });
        }

        // Verify registered and paired locker
        const { data: locker, error: lockerError } =
            await supabaseAdmin
                .from("lockers")
                .select("id, owner_id")
                .eq("device_uuid", deviceUuid)
                .maybeSingle();

        if (lockerError) {
            console.error("Device telemetry request lookup error:", lockerError);

            return res.status(500).json({
                error: "Unable to verify locker"
            });
        }

        if (!locker) {
            return res.status(404).json({
                error: "Locker is not registered"
            });
        }

        if (!locker.owner_id) {
            return res.status(403).json({
                error: "Locker is not paired"
            });
        }

        // Retrieve oldest pending request
        const { data: request, error: requestError } =
            await supabaseAdmin
                .from("telemetry_requests")
                .select("id, locker_id, status, requested_at")
                .eq("locker_id", locker.id)
                .eq("status", "pending")
                .order("requested_at", { ascending: true })
                .limit(1)
                .maybeSingle();

        if (requestError) {
            console.error("Pending telemetry retrieval error:", requestError);

            return res.status(500).json({
                error: "Unable to retrieve pending telemetry request"
            });
        }

        return res.status(200).json({
            message: request
                ? "Pending telemetry request found"
                : "No pending telemetry requests",
            request: request || null
        });

    } catch (error) {
        console.error("Device telemetry polling error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});



// GET TELEMETRY REQUEST STATUS
router.get("/:deviceUuid/requests/:requestId", authenticate, async (req, res) => {
    try {
        const { deviceUuid, requestId } = req.params;

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(deviceUuid)) {
            return res.status(400).json({
                error: "Invalid device UUID"
            });
        }

        if (!/^[1-9]\d*$/.test(requestId)) {
            return res.status(400).json({
                error: "Invalid request ID"
            });
        }

        // Verify locker ownership
        const { data: locker, error: lockerError } =
            await req.supabase
                .from("lockers")
                .select("id, device_uuid")
                .eq("device_uuid", deviceUuid)
                .maybeSingle();

        if (lockerError) {
            console.error("Request status locker lookup error:", lockerError);

            return res.status(500).json({
                error: "Unable to verify locker"
            });
        }

        if (!locker) {
            return res.status(404).json({
                error: "Locker not found or access denied"
            });
        }

        // Retrieve request
        const { data: request, error: requestError } =
            await supabaseAdmin
                .from("telemetry_requests")
                .select("*")
                .eq("id", requestId)
                .eq("locker_id", locker.id)
                .maybeSingle();

        if (requestError) {
            console.error("Telemetry request status error:", requestError);

            return res.status(500).json({
                error: "Unable to retrieve request status"
            });
        }

        if (!request) {
            return res.status(404).json({
                error: "Telemetry request not found"
            });
        }

        // Retrieve the exact telemetry record, if fulfilled
        let telemetry = null;

        if (request.telemetry_id !== null) {
            const { data: telemetryRecord, error: telemetryError } =
                await supabaseAdmin
                    .from("locker_telemetry")
                    .select("id, locker_id, recorded_at, received_at, payload")
                    .eq("id", request.telemetry_id)
                    .maybeSingle();

            if (telemetryError) {
                console.error("Requested telemetry retrieval error:", telemetryError);

                return res.status(500).json({
                    error: "Unable to retrieve requested telemetry"
                });
            }

            telemetry = telemetryRecord;
        }

        return res.status(200).json({
            message: "Telemetry request status retrieved successfully",
            request,
            telemetry
        });

    } catch (error) {
        console.error("Telemetry request status endpoint error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


export default router;
