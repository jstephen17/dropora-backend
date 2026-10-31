import express from "express";
import { authenticate } from "../middleware/authenticate.js";
import { randomInt } from "crypto";
import { supabaseAdmin } from "../config/supabase.js";

const router = express.Router();

// REGISTER DEVICE
router.post("/register", async (req, res) => {
    try {
        const { device_uuid } = req.body;

        // Validate input
        if (!device_uuid) {
            return res.status(400).json({
                error: "Device UUID is required"
            });
        }

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(device_uuid)) {
            return res.status(400).json({
                error: "Invalid device UUID"
            });
        }

        // Check whether device is already registered
        const { data: existingDevice, error: fetchError } =
            await supabaseAdmin
                .from("lockers")
                .select("id, device_uuid, created_at")
                .eq("device_uuid", device_uuid)
                .maybeSingle();

        if (fetchError) {
            console.error("Device lookup error:", fetchError);

            return res.status(500).json({
                error: "Unable to check device registration"
            });
        }

        // Return existing device if already registered
        if (existingDevice) {
            return res.status(200).json({
                message: "Device already registered",
                device: existingDevice
            });
        }

        // Register new device
        const { data: newDevice, error: insertError } =
            await supabaseAdmin
                .from("lockers")
                .insert({
                    device_uuid
                })
                .select("id, device_uuid, created_at")
                .single();

        if (insertError) {
            // Handle simultaneous registration attempts
            if (insertError.code === "23505") {
                return res.status(200).json({
                    message: "Device already registered"
                });
            }

            console.error("Device registration error:", insertError);

            return res.status(500).json({
                error: "Unable to register device"
            });
        }

        return res.status(201).json({
            message: "Device registered successfully",
            device: newDevice
        });

    } catch (error) {
        console.error("Device registration failed:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

// GENERATE OR RETRIEVE PAIRING CODE
router.post("/pairing-code", authenticate, async (req, res) => {
    try {
        const userId = req.user.id;

        // Retrieve the latest pairing request
        const { data: latestRequest, error: fetchError } =
            await req.supabase
                .from("pairing_requests")
                .select("*")
                .eq("user_id", userId)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

        if (fetchError) {
            console.error("Pairing request fetch error:", fetchError);

            return res.status(500).json({
                error: "Unable to retrieve pairing request"
            });
        }

        // Check whether the latest code is still valid
        if (latestRequest && latestRequest.status === "active") {

            const isExpired =
                new Date(latestRequest.expires_at) <= new Date();

            if (!isExpired) {
                return res.status(200).json({
                    message: "Existing pairing code retrieved",
                    pair_code: latestRequest.pair_code,
                    status: latestRequest.status,
                    expires_at: latestRequest.expires_at
                });
            }

            // Mark expired code
            const { error: updateError } = await req.supabase
                .from("pairing_requests")
                .update({ status: "expired" })
                .eq("id", latestRequest.id);

            if (updateError) {
                console.error("Pairing expiration error:", updateError);

                return res.status(500).json({
                    error: "Unable to update pairing request"
                });
            }
        }

        // Generate a new four-digit code
        const pairCode = String(randomInt(0, 10000)).padStart(4, "0");

        // Set expiration to 5 minutes
        const expiresAt = new Date(
            Date.now() + 5 * 60 * 1000
        ).toISOString();

        // Insert the new pairing request
        const { data: newRequest, error: insertError } =
            await req.supabase
                .from("pairing_requests")
                .insert({
                    user_id: userId,
                    pair_code: pairCode,
                    expires_at: expiresAt
                })
                .select()
                .single();

        if (insertError) {
            console.error("Pairing request insert error:", insertError);

            return res.status(500).json({
                error: "Unable to generate pairing code"
            });
        }

        // Return the generated code
        return res.status(201).json({
            message: "Pairing code generated successfully",
            pair_code: newRequest.pair_code,
            expires_at: newRequest.expires_at
        });

    } catch (error) {
        console.error("Pairing code error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

// PAIR DEVICE
router.post("/pair", async (req, res) => {
    try {
        const { device_uuid, pair_code } = req.body;

        // Validate request
        if (!device_uuid || !pair_code) {
            return res.status(400).json({
                error: "Device UUID and pairing code are required"
            });
        }

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(device_uuid) || !/^\d{4}$/.test(pair_code)) {
            return res.status(400).json({
                error: "Invalid device UUID or pairing code"
            });
        }

        // Check whether device is registered
        const { data: device, error: deviceError } =
            await supabaseAdmin
                .from("lockers")
                .select("*")
                .eq("device_uuid", device_uuid)
                .maybeSingle();

        if (deviceError) {
            console.error("Device lookup error:", deviceError);

            return res.status(500).json({
                error: "Unable to retrieve device"
            });
        }

        if (!device) {
            return res.status(404).json({
                error: "Device is not registered"
            });
        }

        // Check whether device is already paired
        if (device.owner_id) {
            return res.status(409).json({
                error: "Device is already paired"
            });
        }

        // Find the latest active pairing request
        const { data: latestRequest, error: fetchError } =
            await supabaseAdmin
                .from("pairing_requests")
                .select("*")
                .eq("pair_code", pair_code)
                .eq("status", "active")
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

        if (fetchError) {
            console.error("Pairing fetch error:", fetchError);

            return res.status(500).json({
                error: "Unable to check pairing code"
            });
        }

        if (!latestRequest) {
            return res.status(404).json({
                error: "Invalid or unavailable pairing code"
            });
        }

        // Check expiration
        const isExpired =
            new Date(latestRequest.expires_at) <= new Date();

        if (isExpired) {
            const { error: updateError } = await supabaseAdmin
                .from("pairing_requests")
                .update({ status: "expired" })
                .eq("id", latestRequest.id);

            if (updateError) {
                console.error("Expiration update error:", updateError);

                return res.status(500).json({
                    error: "Unable to update pairing request"
                });
            }

            return res.status(410).json({
                error: "Pairing code has expired"
            });
        }

        // Assign device to user
        const { data: pairedDevice, error: pairError } =
            await supabaseAdmin
                .from("lockers")
                .update({
                    owner_id: latestRequest.user_id,
                    paired_at: new Date().toISOString()
                })
                .eq("id", device.id)
                .is("owner_id", null)
                .select("id, device_uuid, owner_id, paired_at")
                .maybeSingle();

        if (pairError) {
            console.error("Device pairing error:", pairError);

            return res.status(500).json({
                error: "Unable to pair device"
            });
        }

        if (!pairedDevice) {
            return res.status(409).json({
                error: "Device has already been paired"
            });
        }

        // Mark pairing request as used
        const { error: statusError } = await supabaseAdmin
            .from("pairing_requests")
            .update({ status: "used" })
            .eq("id", latestRequest.id)
            .eq("status", "active");

        if (statusError) {
            console.error("Pairing status update error:", statusError);

            return res.status(500).json({
                error: "Device paired, but pairing status update failed"
            });
        }

        return res.status(200).json({
            message: "Device paired successfully",
            device: pairedDevice
        });

    } catch (error) {
        console.error("Pairing failed:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

export default router;