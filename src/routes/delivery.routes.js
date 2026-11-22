
import express from "express";
import { authenticate } from "../middleware/authenticate.js";
import { supabaseAdmin } from "../config/supabase.js";

const router = express.Router();

const VALID_STATUSES = [
    "to_receive",
    "received",
    "cancelled"
];

// REGISTER DELIVERY
router.post("/", authenticate, async (req, res) => {
    try {
        const { courier_type, parcel_id } = req.body;

        if (
            typeof courier_type !== "string" ||
            typeof parcel_id !== "string" ||
            !courier_type.trim() ||
            !parcel_id.trim()
        ) {
            return res.status(400).json({
                error: "Courier type and parcel ID are required"
            });
        }

        if (
            courier_type.trim().length > 100 ||
            parcel_id.trim().length > 255
        ) {
            return res.status(400).json({
                error: "Courier type or parcel ID is too long"
            });
        }

        const { data: delivery, error } =
            await req.supabase
                .from("delivery_events")
                .insert({
                    user_id: req.user.id,
                    courier_type: courier_type.trim(),
                    parcel_id: parcel_id.trim(),
                    status: "to_receive"
                })
                .select("*")
                .single();

        if (error) {
            console.error("Delivery registration error:", error);

            return res.status(500).json({
                error: "Unable to register delivery"
            });
        }

        return res.status(201).json({
            message: "Delivery registered successfully",
            delivery
        });

    } catch (error) {
        console.error("Delivery registration failed:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


// GET USER DELIVERIES
router.get("/", authenticate, async (req, res) => {
    try {
        const { data: deliveries, error } =
            await req.supabase
                .from("delivery_events")
                .select("*")
                .eq("user_id", req.user.id)
                .order("created_at", { ascending: false });

        if (error) {
            console.error("Delivery retrieval error:", error);

            return res.status(500).json({
                error: "Unable to retrieve deliveries"
            });
        }

        return res.status(200).json({
            message: "Deliveries retrieved successfully",
            total: deliveries.length,
            deliveries
        });

    } catch (error) {
        console.error("Delivery retrieval failed:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

// GET PENDING DELIVERIES FOR A PAIRED LOCKER
router.get("/device/:deviceUuid/to-receive", async (req, res) => {
    try {
        const { deviceUuid } = req.params;

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(deviceUuid)) {
            return res.status(400).json({
                error: "Invalid device UUID"
            });
        }

        // 1. Find the registered locker and its owner
        const { data: locker, error: lockerError } =
            await supabaseAdmin
                .from("lockers")
                .select("id, owner_id")
                .eq("device_uuid", deviceUuid)
                .maybeSingle();

        if (lockerError) {
            console.error("Locker lookup error:", lockerError);

            return res.status(500).json({
                error: "Unable to verify locker"
            });
        }

        // 2. Ensure the locker exists and has been paired
        if (!locker || !locker.owner_id) {
            return res.status(403).json({
                error: "Locker is not registered or paired"
            });
        }

        // 3. Retrieve only this owner's pending deliveries
        const { data: deliveries, error: deliveryError } =
            await supabaseAdmin
                .from("delivery_events")
                .select("id, courier_type, parcel_id, status, created_at")
                .eq("user_id", locker.owner_id)
                .eq("status", "to_receive")
                .order("created_at", { ascending: false });

        if (deliveryError) {
            console.error("Pending delivery retrieval error:", deliveryError);

            return res.status(500).json({
                error: "Unable to retrieve pending deliveries"
            });
        }

        // 4. Return the pending deliveries to the locker
        return res.status(200).json({
            message: "Pending deliveries retrieved successfully",
            device_uuid: deviceUuid,
            total: deliveries.length,
            deliveries
        });

    } catch (error) {
        console.error("Locker delivery retrieval failed:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


// UPDATE DELIVERY STATUS
router.patch("/:id/status", authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                error: "Invalid delivery ID"
            });
        }

        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({
                error: "Invalid delivery status",
                valid_statuses: VALID_STATUSES
            });
        }

        const { data: delivery, error } =
            await req.supabase
                .from("delivery_events")
                .update({ status })
                .eq("id", id)
                .eq("user_id", req.user.id)
                .select("*")
                .maybeSingle();

        if (error) {
            console.error("Delivery update error:", error);

            return res.status(500).json({
                error: "Unable to update delivery"
            });
        }

        if (!delivery) {
            return res.status(404).json({
                error: "Delivery not found"
            });
        }

        return res.status(200).json({
            message: "Delivery status updated successfully",
            delivery
        });

    } catch (error) {
        console.error("Delivery status update failed:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

// UPDATE DELIVERY STATUS THROUGH PAIRED LOCKER
router.patch("/device/:deviceUuid/:deliveryId/status", async (req, res) => {
    try {
        const { deviceUuid, deliveryId } = req.params;
        const { status } = req.body;

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(deviceUuid) || !uuidRegex.test(deliveryId)) {
            return res.status(400).json({
                error: "Invalid device UUID or delivery ID"
            });
        }

        if (!["received", "cancelled"].includes(status)) {
            return res.status(400).json({
                error: "Invalid delivery status"
            });
        }

        // 1. Verify registered and paired locker
        const { data: locker, error: lockerError } =
            await supabaseAdmin
                .from("lockers")
                .select("id, owner_id")
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

        // 2. Update only a delivery belonging to the paired user
        const { data: delivery, error: updateError } =
            await supabaseAdmin
                .from("delivery_events")
                .update({ status })
                .eq("id", deliveryId)
                .eq("user_id", locker.owner_id)
                .eq("status", "to_receive")
                .select("*")
                .maybeSingle();

        if (updateError) {
            console.error("Delivery update error:", updateError);
            return res.status(500).json({
                error: "Unable to update delivery"
            });
        }

        if (!delivery) {
            return res.status(404).json({
                error: "Pending delivery not found"
            });
        }

        return res.status(200).json({
            message: "Delivery status updated successfully",
            delivery
        });

    } catch (error) {
        console.error("Locker delivery update failed:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


// DELETE DELIVERY
router.delete("/:id", authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                error: "Invalid delivery ID"
            });
        }

        const { data: delivery, error } =
            await req.supabase
                .from("delivery_events")
                .delete()
                .eq("id", id)
                .eq("user_id", req.user.id)
                .select("id")
                .maybeSingle();

        if (error) {
            console.error("Delivery deletion error:", error);

            return res.status(500).json({
                error: "Unable to delete delivery"
            });
        }

        if (!delivery) {
            return res.status(404).json({
                error: "Delivery not found"
            });
        }

        return res.status(200).json({
            message: "Delivery deleted successfully"
        });

    } catch (error) {
        console.error("Delivery deletion failed:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

export default router;
