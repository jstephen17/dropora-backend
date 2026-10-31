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

export default router;