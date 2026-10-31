
import express from "express";
import { supabase } from "../config/supabase.js";
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

        const { data, error } = await supabase.auth.signUp({
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

        const { data, error } =
            await supabase.auth.signInWithPassword({
                email,
                password
            });

        if (error) {
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

export default router;
