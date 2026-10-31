
import { createUserClient } from "../config/supabase.js";

export async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "Authentication token required"
        });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({
            error: "Invalid authentication header"
        });
    }

    const userClient = createUserClient(token);

    const {
        data: { user },
        error
    } = await userClient.auth.getUser(token);

    if (error || !user) {
        return res.status(401).json({
            error: "Invalid or expired token"
        });
    }

    req.user = user;
    req.supabase = userClient;

    next();
}
