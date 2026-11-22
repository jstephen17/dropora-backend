
import express from "express";
import { supabase, supabaseAdmin, createAuthClient } from "../config/supabase.js";
import { authenticate } from "../middleware/authenticate.js";

const router = express.Router();

// REGISTER
router.post("/register", async (req, res) => {
    try {
        const { email, password, username } = req.body;

        if (!email || !password || !username) {
            return res.status(400).json({
                error: "Email, password, and username are required"
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                error: "Password must be at least 8 characters"
            });
        }

    const authClient = createAuthClient();

    const { data, error } = await authClient.auth.signUp({
            email,
            password,
            options: {
                data: {
                    username
                }
            }
        });

        if (error) {
            return res.status(400).json({
                error: error.message
            });
        }

        return res.status(201).json({
            message: data.session
                ? "Account created successfully"
                : "Account created. Please verify your email.",
            user: {
                id: data.user.id,
                email: data.user.email,
                username: data.user.user_metadata?.username
            },
            session: data.session
        });

    } catch (err) {
        console.error("Registration error:", err);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


// LOGIN
router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                error: "Email and password are required"
            });
        }

        const authClient = createAuthClient();

        const { data, error } =
            await authClient.auth.signInWithPassword({
                email,
                password
            });

        if (error || !data.session) {
            return res.status(401).json({
                error: "Invalid email or password"
            });
        }

        return res.status(200).json({
            message: "Login successful",
            user: {
                id: data.user.id,
                email: data.user.email
            },
            session: data.session
        });

    } catch (err) {
        console.error("Login error:", err);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

// REFRESH SESSION
router.post("/refresh", async (req, res) => {
    try {
        const { refresh_token } = req.body;

        if (
            typeof refresh_token !== "string" ||
            !refresh_token.trim()
        ) {
            return res.status(400).json({
                error: "Refresh token is required"
            });
        }

        // Create an isolated client for this refresh operation
        const authClient = createAuthClient();

        const { data, error } =
            await authClient.auth.refreshSession({
                refresh_token
            });

        if (error || !data.session) {
            return res.status(401).json({
                error: "Invalid or expired refresh token. Please log in again."
            });
        }

        return res.status(200).json({
            message: "Session refreshed successfully",
            user: {
                id: data.user.id,
                email: data.user.email
            },
            session: data.session
        });

    } catch (err) {
        console.error("Session refresh error:", err);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


// LOGOUT
router.post("/logout", authenticate, async (req, res) => {
    try {
        const { error } = await supabaseAdmin.auth.admin.signOut(
            req.accessToken,
            "local"
        );

        if (error) {
            console.error("Logout error:", error);

            return res.status(400).json({
                error: "Unable to revoke user session"
            });
        }

        return res.status(200).json({
            message: "Logged out successfully",
            session_revoked: true
        });

    } catch (error) {
        console.error("Logout error:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


// GET CURRENT USER
router.get("/me", authenticate, async (req, res) => {
    try {
        const { data: profile, error } = await req.supabase
            .from("profiles")
            .select("*")
            .eq("id", req.user.id)
            .single();

        if (error) {
            console.error("Profile query error:", error);

            return res.status(500).json({
                error: "Unable to retrieve user profile"
            });
        }

        return res.status(200).json({
            user: {
                id: req.user.id,
                email: req.user.email,
                profile
            }
        });

    } catch (err) {
        console.error("Profile error:", err);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

// DELETE ACCOUNT
router.delete("/delete", authenticate, async (req, res) => {
    try {
        const userId = req.user.id;

        // Find all lockers owned by this account
        const { data: lockers, error: lockerError } =
            await supabaseAdmin
                .from("lockers")
                .select("id")
                .eq("owner_id", userId);

        if (lockerError) {
            console.error("Locker lookup error:", lockerError);

            return res.status(500).json({
                error: "Unable to retrieve associated lockers"
            });
        }

        const lockerIds = lockers.map(locker => locker.id);

        // Delete historical locker events and telemetry
        if (lockerIds.length > 0) {

            const { error: eventsError } =
                await supabaseAdmin
                    .from("locker_events")
                    .delete()
                    .in("locker_id", lockerIds);

            if (eventsError) {
                console.error("Locker events deletion error:", eventsError);

                return res.status(500).json({
                    error: "Unable to delete locker events"
                });
            }

            const { error: telemetryError } =
                await supabaseAdmin
                    .from("locker_telemetry")
                    .delete()
                    .in("locker_id", lockerIds);

            if (telemetryError) {
                console.error("Telemetry deletion error:", telemetryError);

                return res.status(500).json({
                    error: "Unable to delete locker telemetry"
                });
            }
        }

        // Delete the authenticated Supabase user
        const { error: deleteError } =
            await supabaseAdmin.auth.admin.deleteUser(userId);

        if (deleteError) {
            console.error("Account deletion error:", deleteError);

            return res.status(500).json({
                error: "Unable to delete account"
            });
        }

        // Clear the pairing timestamp on retained devices
        if (lockerIds.length > 0) {
            const { error: unpairError } =
                await supabaseAdmin
                    .from("lockers")
                    .update({ paired_at: null })
                    .in("id", lockerIds);

            if (unpairError) {
                console.error("Locker unpair cleanup warning:", unpairError);
            }
        }

        return res.status(200).json({
            message: "Account deleted successfully"
        });

    } catch (error) {
        console.error("Account deletion failed:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});

export default router;
