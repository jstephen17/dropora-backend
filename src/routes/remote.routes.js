import express from "express";
import { authenticate } from "../middleware/authenticate.js";
import { supabaseAdmin } from "../config/supabase.js";

const router = express.Router();

// UUID VALIDATION
const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


// USER: CREATE A REMOTE COMMAND

router.post("/commands", authenticate, async (req, res) => {
    try {
        const { device_uuid, door_locked, power_saving } = req.body;

        // Validate device UUID
        if (
            typeof device_uuid !== "string" ||
            !uuidRegex.test(device_uuid)
        ) {
            return res.status(400).json({
                error: "Invalid device UUID"
            });
        }

        // Both values must be supplied because this is a
        // complete desired-state command.
        if (
            typeof door_locked !== "boolean" ||
            typeof power_saving !== "boolean"
        ) {
            return res.status(400).json({
                error: "door_locked and power_saving must be boolean values"
            });
        }

        // Verify that the device belongs to the authenticated user
        const { data: locker, error: lockerError } =
            await req.supabase
                .from("lockers")
                .select("id, device_uuid")
                .eq("device_uuid", device_uuid)
                .maybeSingle();

        if (lockerError) {
            console.error("Remote command locker lookup error:", lockerError);

            return res.status(500).json({
                error: "Unable to verify locker"
            });
        }

        if (!locker) {
            return res.status(404).json({
                error: "Locker not found or access denied"
            });
        }

        // Insert the remote command
        const { data: command, error: commandError } =
            await req.supabase
                .from("remote_commands")
                .insert({
                    locker_id: locker.id,
                    door_locked,
                    power_saving
                })
                .select(`
                    id,
                    locker_id,
                    door_locked,
                    power_saving,
                    status,
                    created_at,
                    fulfilled_at
                `)
                .single();

        if (commandError) {
            console.error("Remote command insertion error:", commandError);

            return res.status(500).json({
                error: "Unable to create remote command"
            });
        }

        return res.status(201).json({
            message: "Remote command created successfully",
            device_uuid: locker.device_uuid,
            command
        });

    } catch (error) {
        console.error("Remote command creation endpoint error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


// RETRIEVE LATEST PENDING REMOTE COMMAND

router.get("/device/:deviceUuid/commands/latest", async (req, res) => {
    try {
        const { deviceUuid } = req.params;

        if (!uuidRegex.test(deviceUuid)) {
            return res.status(400).json({
                error: "Invalid device UUID"
            });
        }

        // Verify that the device is registered and paired
        const { data: locker, error: lockerError } =
            await supabaseAdmin
                .from("lockers")
                .select("id, device_uuid, owner_id")
                .eq("device_uuid", deviceUuid)
                .maybeSingle();

        if (lockerError) {
            console.error("Device locker lookup error:", lockerError);

            return res.status(500).json({
                error: "Unable to verify locker"
            });
        }

        if (!locker || !locker.owner_id) {
            return res.status(403).json({
                error: "Locker is not registered or paired"
            });
        }

        // Retrieve the newest pending command for this locker
        const { data: command, error: commandError } =
            await supabaseAdmin
                .from("remote_commands")
                .select(`
                    id,
                    locker_id,
                    door_locked,
                    power_saving,
                    status,
                    created_at
                `)
                .eq("locker_id", locker.id)
                .eq("status", "pending")
                .order("created_at", { ascending: false })
                .order("id", { ascending: false })
                .limit(1)
                .maybeSingle();

        if (commandError) {
            console.error("Remote command retrieval error:", commandError);

            return res.status(500).json({
                error: "Unable to retrieve remote command"
            });
        }

        return res.status(200).json({
            message: command
                ? "Pending remote command retrieved"
                : "No pending remote commands",
            device_uuid: deviceUuid,
            command
        });

    } catch (error) {
        console.error("Device remote command retrieval error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


// MARK A REMOTE COMMAND AS FULFILLED

router.patch(
    "/device/:deviceUuid/commands/:commandId/fulfill",
    async (req, res) => {
        try {
            const { deviceUuid, commandId } = req.params;

            if (!uuidRegex.test(deviceUuid)) {
                return res.status(400).json({
                    error: "Invalid device UUID"
                });
            }

            // Validate command ID
            if (!/^[1-9]\d*$/.test(commandId)) {
                return res.status(400).json({
                    error: "Invalid command ID"
                });
            }

            // Verify that the device is registered and paired
            const { data: locker, error: lockerError } =
                await supabaseAdmin
                    .from("lockers")
                    .select("id, owner_id")
                    .eq("device_uuid", deviceUuid)
                    .maybeSingle();

            if (lockerError) {
                console.error("Device locker lookup error:", lockerError);

                return res.status(500).json({
                    error: "Unable to verify locker"
                });
            }

            if (!locker || !locker.owner_id) {
                return res.status(403).json({
                    error: "Locker is not registered or paired"
                });
            }

            // Only fulfill a pending command belonging to this device
            const { data: command, error: updateError } =
                await supabaseAdmin
                    .from("remote_commands")
                    .update({
                        status: "fulfilled",
                        fulfilled_at: new Date().toISOString()
                    })
                    .eq("id", commandId)
                    .eq("locker_id", locker.id)
                    .eq("status", "pending")
                    .select(`
                        id,
                        locker_id,
                        door_locked,
                        power_saving,
                        status,
                        created_at,
                        fulfilled_at
                    `)
                    .maybeSingle();

            if (updateError) {
                console.error("Remote command fulfillment error:", updateError);

                return res.status(500).json({
                    error: "Unable to fulfill remote command"
                });
            }

            if (!command) {
                return res.status(404).json({
                    error: "Pending command not found for this device"
                });
            }

            return res.status(200).json({
                message: "Remote command fulfilled successfully",
                device_uuid: deviceUuid,
                command
            });

        } catch (error) {
            console.error("Remote command fulfillment endpoint error:", error);

            return res.status(500).json({
                error: "Internal server error"
            });
        }
    }
);


// USER RETRIEVE REMOTE COMMAND HISTORY WITH PAGINATION

router.get("/:deviceUuid/commands", authenticate, async (req, res) => {
    try {
        const { deviceUuid } = req.params;

        const offset = Number(req.query.offset ?? 0);
        const limit = Number(req.query.limit ?? 10);

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

        // Verify that the locker belongs to the authenticated user
        const { data: locker, error: lockerError } =
            await req.supabase
                .from("lockers")
                .select("id, device_uuid")
                .eq("device_uuid", deviceUuid)
                .maybeSingle();

        if (lockerError) {
            console.error("Remote history locker lookup error:", lockerError);

            return res.status(500).json({
                error: "Unable to retrieve locker"
            });
        }

        if (!locker) {
            return res.status(404).json({
                error: "Locker not found or access denied"
            });
        }

        // Retrieve remote command history
        const {
            data: commands,
            error: commandError,
            count
        } = await req.supabase
            .from("remote_commands")
            .select(`
                id,
                locker_id,
                door_locked,
                power_saving,
                status,
                created_at,
                fulfilled_at
            `, { count: "exact" })
            .eq("locker_id", locker.id)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(offset, offset + limit - 1);

        if (commandError) {
            console.error("Remote history retrieval error:", commandError);

            return res.status(500).json({
                error: "Unable to retrieve remote command history"
            });
        }

        const total = count ?? 0;
        const hasMore = offset + commands.length < total;

        return res.status(200).json({
            message: "Remote command history retrieved successfully",
            locker: {
                id: locker.id,
                device_uuid: locker.device_uuid
            },
            pagination: {
                offset,
                limit,
                total,
                returned: commands.length,
                has_more: hasMore,
                next_offset: hasMore
                    ? offset + commands.length
                    : null
            },
            commands
        });

    } catch (error) {
        console.error("Remote history endpoint error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


export default router;