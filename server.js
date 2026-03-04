import dotenv from "dotenv";
dotenv.config();
import crypto from "crypto";
import cors from "cors";
import express from "express";
import { OAuth2Client } from "google-auth-library";
import { pool, healthCheck } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 8080);
const googleWebClientID = process.env.GOOGLE_WEB_CLIENT_ID || "";
const sessionTtlDays = Number(process.env.SESSION_TTL_DAYS || 30);
const matchingRadiusKm = Number(process.env.MATCH_RADIUS_KM || 10);
const platformFeePercent = Number(process.env.PLATFORM_FEE_PERCENT || 15);
const googleClient = new OAuth2Client(googleWebClientID);

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));

function ok(responseData = {}, responseMsg = "Success") {
    return {
        response_status: 1,
        response_msg: responseMsg,
        response_data: responseData
    };
}

function fail(responseMsg = "Something went wrong", status = 400) {
    return {
        status,
        body: {
            response_status: 0,
            response_msg: responseMsg,
            response_data: {}
        }
    };
}

function pickSessionToken(req) {
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
        return authHeader.replace("Bearer ", "").trim();
    }
    return req.body?.session_token || req.query?.session_token || "";
}

function profileResponseFromRow(row) {
    return {
        user_id: row.id,
        first_name: row.first_name ?? "",
        last_name: row.last_name ?? "",
        email: row.email ?? "",
        mobile: row.mobile ?? "",
        address: row.address ?? "",
        profile_pic: row.profile_pic ?? "",
        stripe_connect_status: row.stripe_connect_status ?? "0"
    };
}

function taskResponseFromRow(row) {
    return {
        task_id: row.id,
        requester_id: row.requester_id,
        title: row.title,
        description: row.description,
        category: row.category,
        pickup_address: row.pickup_address,
        dropoff_address: row.dropoff_address,
        latitude: row.latitude,
        longitude: row.longitude,
        scheduled_time: row.scheduled_time,
        urgency: row.urgency,
        price: row.price,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

async function createTaskEvent(taskId, actorUserId, eventType, payload = {}) {
    await pool.query(
        `INSERT INTO task_events (task_id, actor_user_id, event_type, payload)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [taskId, actorUserId, eventType, JSON.stringify(payload)]
    );
}

function validateTaskStatusTransition(currentStatus, nextStatus) {
    const transitions = {
        draft: new Set(["open", "cancelled"]),
        open: new Set(["matched", "cancelled"]),
        matched: new Set(["in_progress", "cancelled"]),
        in_progress: new Set(["completed", "cancelled", "disputed"]),
        completed: new Set([]),
        cancelled: new Set([]),
        disputed: new Set(["completed", "cancelled"])
    };
    return transitions[currentStatus]?.has(nextStatus) || false;
}

async function authBySessionToken(req, res, next) {
    try {
        const token = pickSessionToken(req);
        if (!token) {
            const err = fail("Missing session_token", 401);
            return res.status(err.status).json(err.body);
        }

        const { rows } = await pool.query(
            `SELECT s.session_token, s.expires_at, s.revoked_at, u.*
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.session_token = $1
             LIMIT 1`,
            [token]
        );

        const row = rows[0];
        if (!row) {
            const err = fail("Invalid session", 401);
            return res.status(err.status).json(err.body);
        }
        if (row.revoked_at) {
            const err = fail("Session revoked", 401);
            return res.status(err.status).json(err.body);
        }
        if (new Date(row.expires_at).getTime() <= Date.now()) {
            const err = fail("Session expired", 401);
            return res.status(err.status).json(err.body);
        }

        req.userRow = row;
        req.sessionToken = token;
        next();
    } catch (error) {
        console.error("authBySessionToken error:", error);
        const err = fail("Auth error", 500);
        return res.status(err.status).json(err.body);
    }
}

app.get("/", (_req, res) => {
    return res.status(200).json(ok({ service: "canupls-api" }, "API is running"));
});

app.get("/health", async (_req, res) => {
    try {
        const now = await healthCheck();
        return res.status(200).json(ok({ db_time: now }, "Healthy"));
    } catch (error) {
        console.error("health check failed:", error);
        const err = fail("Database connection failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.post("/v1/auth/google/ios", async (req, res) => {
    try {
        if (!googleWebClientID) {
            const err = fail("Backend missing GOOGLE_WEB_CLIENT_ID", 500);
            return res.status(err.status).json(err.body);
        }

        const idToken = req.body?.idToken || req.body?.id_token || "";
        if (!idToken) {
            const err = fail("Missing idToken", 400);
            return res.status(err.status).json(err.body);
        }

        let ticket;
        try {
            ticket = await googleClient.verifyIdToken({
                idToken,
                audience: googleWebClientID
            });
        } catch (verifyError) {
            console.error("verifyIdToken error:", verifyError);
            const err = fail("Token verification failed", 401);
            return res.status(err.status).json(err.body);
        }

        const payload = ticket.getPayload();
        if (!payload?.sub || !payload?.email) {
            const err = fail("Google token missing required fields", 400);
            return res.status(err.status).json(err.body);
        }

        const googleSub = payload.sub;
        const email = String(payload.email || "").toLowerCase().trim();
        const firstName = String(req.body?.first_name || req.body?.firstName || payload.given_name || "");
        const lastName = String(req.body?.last_name || req.body?.lastName || payload.family_name || "");
        const profilePic = String(req.body?.profile_pic || req.body?.profilePic || payload.picture || "");

        let user;
        const existing = await pool.query(
            `SELECT * FROM users WHERE google_sub = $1 OR email = $2 LIMIT 1`,
            [googleSub, email]
        );

        if (existing.rows[0]) {
            const userId = existing.rows[0].id;
            const updated = await pool.query(
                `UPDATE users
                 SET google_sub = $1,
                     email = $2,
                     first_name = COALESCE(NULLIF($3, ''), first_name),
                     last_name = COALESCE(NULLIF($4, ''), last_name),
                     profile_pic = COALESCE(NULLIF($5, ''), profile_pic),
                     updated_at = NOW()
                 WHERE id = $6
                 RETURNING *`,
                [googleSub, email, firstName, lastName, profilePic, userId]
            );
            user = updated.rows[0];
        } else {
            const created = await pool.query(
                `INSERT INTO users (google_sub, email, first_name, last_name, profile_pic)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
                [googleSub, email, firstName, lastName, profilePic]
            );
            user = created.rows[0];
        }

        const sessionToken = `sess_${crypto.randomBytes(32).toString("hex")}`;
        const deviceId = String(req.body?.device_id || req.body?.deviceId || "");
        const platform = String(req.body?.platform || "ios");
        const expiresAt = new Date(Date.now() + sessionTtlDays * 24 * 60 * 60 * 1000);

        await pool.query(
            `INSERT INTO sessions (session_token, user_id, device_id, platform, expires_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [sessionToken, user.id, deviceId, platform, expiresAt]
        );

        return res.status(200).json(ok({
            session_token: sessionToken,
            user_info: profileResponseFromRow(user)
        }));
    } catch (error) {
        console.error("google auth error:", error);
        const err = fail("Google auth failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.post("/v1/devices/register", authBySessionToken, async (req, res) => {
    try {
        const firebaseToken = String(req.body?.firebase_token || req.body?.firebaseToken || "").trim();
        const platform = String(req.body?.platform || "ios").trim();
        if (!firebaseToken) {
            const err = fail("Missing firebase_token", 400);
            return res.status(err.status).json(err.body);
        }

        await pool.query(
            `INSERT INTO devices (user_id, firebase_token, platform)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, firebase_token)
             DO UPDATE SET platform = EXCLUDED.platform, updated_at = NOW()`,
            [req.userRow.id, firebaseToken, platform]
        );

        return res.status(200).json(ok({}, "Device token saved"));
    } catch (error) {
        console.error("device register error:", error);
        const err = fail("Device register failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.post("/v1/location/update", authBySessionToken, async (req, res) => {
    try {
        const latitude = Number(req.body?.latitude);
        const longitude = Number(req.body?.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            const err = fail("Invalid latitude/longitude", 400);
            return res.status(err.status).json(err.body);
        }

        await pool.query(
            `INSERT INTO user_locations (user_id, latitude, longitude, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id)
             DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, updated_at = NOW()`,
            [req.userRow.id, latitude, longitude]
        );

        return res.status(200).json(ok({}, "Location updated"));
    } catch (error) {
        console.error("location update error:", error);
        const err = fail("Location update failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.get("/v1/profile", authBySessionToken, async (req, res) => {
    return res.status(200).json(ok({
        user_info: profileResponseFromRow(req.userRow)
    }));
});

app.post("/v1/profile/update", authBySessionToken, async (req, res) => {
    try {
        const firstName = String(req.body?.first_name || req.body?.firstName || "");
        const lastName = String(req.body?.last_name || req.body?.lastName || "");
        const email = String(req.body?.email || "").toLowerCase().trim();
        const mobile = String(req.body?.mobile || "");
        const address = String(req.body?.address || "");
        const profilePic = String(req.body?.profile_pic || req.body?.profilePic || "");

        const { rows } = await pool.query(
            `UPDATE users
             SET first_name = COALESCE(NULLIF($1, ''), first_name),
                 last_name = COALESCE(NULLIF($2, ''), last_name),
                 mobile = COALESCE(NULLIF($3, ''), mobile),
                 address = COALESCE(NULLIF($4, ''), address),
                 profile_pic = COALESCE(NULLIF($5, ''), profile_pic),
                 email = COALESCE(NULLIF($6, ''), email),
                 updated_at = NOW()
             WHERE id = $7
             RETURNING *`,
            [firstName, lastName, mobile, address, profilePic, email, req.userRow.id]
        );

        return res.status(200).json(ok({
            user_info: profileResponseFromRow(rows[0])
        }, "Profile updated"));
    } catch (error) {
        console.error("profile update error:", error);
        const err = fail("Profile update failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.post("/v1/tasks", authBySessionToken, async (req, res) => {
    try {
        const title = String(req.body?.title || "").trim();
        const description = String(req.body?.description || "").trim();
        const category = String(req.body?.category || "").trim();
        const pickupAddress = String(req.body?.pickup_address || req.body?.pickupAddress || "").trim();
        const dropoffAddress = String(req.body?.dropoff_address || req.body?.dropoffAddress || "").trim();
        const latitude = Number(req.body?.latitude);
        const longitude = Number(req.body?.longitude);
        const urgency = Boolean(req.body?.urgency);
        const price = req.body?.price != null ? Number(req.body?.price) : null;
        const scheduledTime = req.body?.scheduled_time || req.body?.scheduledTime || null;
        const status = req.body?.status === "draft" ? "draft" : "open";

        if (!title || !category || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            const err = fail("Missing required fields for task", 400);
            return res.status(err.status).json(err.body);
        }

        const { rows } = await pool.query(
            `INSERT INTO tasks (
                requester_id, title, description, category,
                pickup_address, dropoff_address, latitude, longitude,
                scheduled_time, urgency, price, status
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING *`,
            [
                req.userRow.id,
                title,
                description,
                category,
                pickupAddress,
                dropoffAddress,
                latitude,
                longitude,
                scheduledTime,
                urgency,
                price,
                status
            ]
        );

        await createTaskEvent(rows[0].id, req.userRow.id, "task_created", { status });
        return res.status(201).json(ok({ task: taskResponseFromRow(rows[0]) }, "Task created"));
    } catch (error) {
        console.error("create task error:", error);
        const err = fail("Task create failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.get("/v1/tasks/:taskId", authBySessionToken, async (req, res) => {
    try {
        const { taskId } = req.params;
        const { rows } = await pool.query(`SELECT * FROM tasks WHERE id = $1 LIMIT 1`, [taskId]);
        if (!rows[0]) {
            const err = fail("Task not found", 404);
            return res.status(err.status).json(err.body);
        }
        return res.status(200).json(ok({ task: taskResponseFromRow(rows[0]) }));
    } catch (error) {
        console.error("get task error:", error);
        const err = fail("Task fetch failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.get("/v1/tasks", authBySessionToken, async (req, res) => {
    try {
        const status = String(req.query?.status || "open");
        const lat = Number(req.query?.lat);
        const lng = Number(req.query?.lng);
        const radiusKm = Number(req.query?.radius || matchingRadiusKm);

        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusKm)) {
            const err = fail("lat, lng, radius are required", 400);
            return res.status(err.status).json(err.body);
        }

        const { rows } = await pool.query(
            `SELECT t.*,
              (6371 * acos(
                cos(radians($1)) * cos(radians(t.latitude)) *
                cos(radians(t.longitude) - radians($2)) +
                sin(radians($1)) * sin(radians(t.latitude))
              )) AS distance_km
             FROM tasks t
             WHERE t.status = $3
             HAVING (6371 * acos(
                cos(radians($1)) * cos(radians(t.latitude)) *
                cos(radians(t.longitude) - radians($2)) +
                sin(radians($1)) * sin(radians(t.latitude))
             )) <= $4
             ORDER BY distance_km ASC, t.created_at DESC`,
            [lat, lng, status, radiusKm]
        );

        return res.status(200).json(ok({
            tasks: rows.map((row) => ({ ...taskResponseFromRow(row), distance_km: Number(row.distance_km) }))
        }));
    } catch (error) {
        console.error("list tasks error:", error);
        const err = fail("Task listing failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.patch("/v1/tasks/:taskId", authBySessionToken, async (req, res) => {
    try {
        const { taskId } = req.params;
        const { rows: taskRows } = await pool.query(`SELECT * FROM tasks WHERE id = $1 LIMIT 1`, [taskId]);
        const task = taskRows[0];
        if (!task) {
            const err = fail("Task not found", 404);
            return res.status(err.status).json(err.body);
        }
        if (task.requester_id !== req.userRow.id) {
            const err = fail("Only requester can edit task", 403);
            return res.status(err.status).json(err.body);
        }
        if (task.status !== "draft" && task.status !== "open") {
            const err = fail("Task cannot be edited in current state", 400);
            return res.status(err.status).json(err.body);
        }

        const title = String(req.body?.title || task.title);
        const description = String(req.body?.description || task.description);
        const category = String(req.body?.category || task.category);
        const pickupAddress = String(req.body?.pickup_address || req.body?.pickupAddress || task.pickup_address);
        const dropoffAddress = String(req.body?.dropoff_address || req.body?.dropoffAddress || task.dropoff_address);
        const latitude = req.body?.latitude != null ? Number(req.body?.latitude) : task.latitude;
        const longitude = req.body?.longitude != null ? Number(req.body?.longitude) : task.longitude;
        const urgency = req.body?.urgency != null ? Boolean(req.body?.urgency) : task.urgency;
        const price = req.body?.price != null ? Number(req.body?.price) : task.price;
        const scheduledTime = req.body?.scheduled_time || req.body?.scheduledTime || task.scheduled_time;

        const { rows } = await pool.query(
            `UPDATE tasks
             SET title = $1, description = $2, category = $3,
                 pickup_address = $4, dropoff_address = $5,
                 latitude = $6, longitude = $7, urgency = $8,
                 price = $9, scheduled_time = $10, updated_at = NOW()
             WHERE id = $11
             RETURNING *`,
            [title, description, category, pickupAddress, dropoffAddress, latitude, longitude, urgency, price, scheduledTime, taskId]
        );

        await createTaskEvent(taskId, req.userRow.id, "task_updated", {});
        return res.status(200).json(ok({ task: taskResponseFromRow(rows[0]) }, "Task updated"));
    } catch (error) {
        console.error("edit task error:", error);
        const err = fail("Task edit failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.post("/v1/tasks/:taskId/cancel", authBySessionToken, async (req, res) => {
    try {
        const { taskId } = req.params;
        const { rows } = await pool.query(`SELECT * FROM tasks WHERE id = $1 LIMIT 1`, [taskId]);
        const task = rows[0];
        if (!task) {
            const err = fail("Task not found", 404);
            return res.status(err.status).json(err.body);
        }
        if (task.requester_id !== req.userRow.id) {
            const err = fail("Only requester can cancel task", 403);
            return res.status(err.status).json(err.body);
        }
        if (!validateTaskStatusTransition(task.status, "cancelled")) {
            const err = fail("Task cannot be cancelled from current status", 400);
            return res.status(err.status).json(err.body);
        }

        const { rows: updatedRows } = await pool.query(
            `UPDATE tasks SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
            [taskId]
        );
        await createTaskEvent(taskId, req.userRow.id, "task_cancelled", {});
        return res.status(200).json(ok({ task: taskResponseFromRow(updatedRows[0]) }, "Task cancelled"));
    } catch (error) {
        console.error("cancel task error:", error);
        const err = fail("Task cancel failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.post("/v1/tasks/:taskId/offers", authBySessionToken, async (req, res) => {
    try {
        const { taskId } = req.params;
        const offeredPrice = Number(req.body?.offered_price || req.body?.offeredPrice);
        const message = String(req.body?.message || "");
        if (!Number.isFinite(offeredPrice)) {
            const err = fail("offered_price is required", 400);
            return res.status(err.status).json(err.body);
        }

        const { rows: taskRows } = await pool.query(`SELECT * FROM tasks WHERE id = $1 LIMIT 1`, [taskId]);
        const task = taskRows[0];
        if (!task) {
            const err = fail("Task not found", 404);
            return res.status(err.status).json(err.body);
        }
        if (task.status !== "open") {
            const err = fail("Offers are allowed only for open tasks", 400);
            return res.status(err.status).json(err.body);
        }
        if (task.requester_id === req.userRow.id) {
            const err = fail("Requester cannot offer own task", 400);
            return res.status(err.status).json(err.body);
        }

        const { rows } = await pool.query(
            `INSERT INTO task_offers (task_id, helper_id, offered_price, message, status)
             VALUES ($1, $2, $3, $4, 'pending')
             ON CONFLICT (task_id, helper_id)
             DO UPDATE SET offered_price = EXCLUDED.offered_price, message = EXCLUDED.message, status = 'pending', updated_at = NOW()
             RETURNING *`,
            [taskId, req.userRow.id, offeredPrice, message]
        );

        await createTaskEvent(taskId, req.userRow.id, "offer_created", { offer_id: rows[0].id });
        return res.status(201).json(ok({ offer: rows[0] }, "Offer submitted"));
    } catch (error) {
        console.error("offer create error:", error);
        const err = fail("Offer create failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.post("/v1/tasks/:taskId/offers/:offerId/accept", authBySessionToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { taskId, offerId } = req.params;

        const { rows: taskRows } = await client.query(`SELECT * FROM tasks WHERE id = $1 LIMIT 1 FOR UPDATE`, [taskId]);
        const task = taskRows[0];
        if (!task) {
            await client.query("ROLLBACK");
            const err = fail("Task not found", 404);
            return res.status(err.status).json(err.body);
        }
        if (task.requester_id !== req.userRow.id) {
            await client.query("ROLLBACK");
            const err = fail("Only requester can accept offer", 403);
            return res.status(err.status).json(err.body);
        }
        if (task.status !== "open") {
            await client.query("ROLLBACK");
            const err = fail("Task is not open for matching", 400);
            return res.status(err.status).json(err.body);
        }

        const { rows: offerRows } = await client.query(
            `SELECT * FROM task_offers WHERE id = $1 AND task_id = $2 LIMIT 1 FOR UPDATE`,
            [offerId, taskId]
        );
        const offer = offerRows[0];
        if (!offer) {
            await client.query("ROLLBACK");
            const err = fail("Offer not found", 404);
            return res.status(err.status).json(err.body);
        }
        if (offer.status !== "pending") {
            await client.query("ROLLBACK");
            const err = fail("Offer is not pending", 400);
            return res.status(err.status).json(err.body);
        }

        await client.query(`UPDATE task_offers SET status = 'accepted', updated_at = NOW() WHERE id = $1`, [offerId]);
        await client.query(
            `UPDATE task_offers SET status = 'rejected', updated_at = NOW() WHERE task_id = $1 AND id <> $2 AND status = 'pending'`,
            [taskId, offerId]
        );
        await client.query(`UPDATE tasks SET status = 'matched', price = $2, updated_at = NOW() WHERE id = $1`, [taskId, offer.offered_price]);
        await client.query(
            `INSERT INTO task_assignments (task_id, helper_id, accepted_at) VALUES ($1, $2, NOW())
             ON CONFLICT (task_id) DO UPDATE SET helper_id = EXCLUDED.helper_id, accepted_at = NOW(), started_at = NULL, completed_at = NULL`,
            [taskId, offer.helper_id]
        );
        await createTaskEvent(taskId, req.userRow.id, "offer_accepted", { offer_id: offerId, helper_id: offer.helper_id });

        await client.query("COMMIT");
        return res.status(200).json(ok({}, "Offer accepted"));
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("accept offer error:", error);
        const err = fail("Offer accept failed", 500);
        return res.status(err.status).json(err.body);
    } finally {
        client.release();
    }
});

app.post("/v1/tasks/:taskId/status", authBySessionToken, async (req, res) => {
    try {
        const { taskId } = req.params;
        const nextStatus = String(req.body?.status || "").trim();
        if (!nextStatus) {
            const err = fail("Missing status", 400);
            return res.status(err.status).json(err.body);
        }

        const { rows: taskRows } = await pool.query(`SELECT * FROM tasks WHERE id = $1 LIMIT 1`, [taskId]);
        const task = taskRows[0];
        if (!task) {
            const err = fail("Task not found", 404);
            return res.status(err.status).json(err.body);
        }

        const { rows: assignmentRows } = await pool.query(`SELECT * FROM task_assignments WHERE task_id = $1 LIMIT 1`, [taskId]);
        const assignment = assignmentRows[0];
        const isRequester = task.requester_id === req.userRow.id;
        const isHelper = assignment?.helper_id === req.userRow.id;
        if (!isRequester && !isHelper) {
            const err = fail("Not authorized for this task", 403);
            return res.status(err.status).json(err.body);
        }

        if (!validateTaskStatusTransition(task.status, nextStatus)) {
            const err = fail(`Invalid transition ${task.status} -> ${nextStatus}`, 400);
            return res.status(err.status).json(err.body);
        }

        if (nextStatus === "in_progress" && !isHelper) {
            const err = fail("Only helper can start task", 403);
            return res.status(err.status).json(err.body);
        }
        if (nextStatus === "completed" && !isHelper && !isRequester) {
            const err = fail("Only participants can complete task", 403);
            return res.status(err.status).json(err.body);
        }

        const { rows: updatedRows } = await pool.query(
            `UPDATE tasks SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
            [taskId, nextStatus]
        );

        if (nextStatus === "in_progress") {
            await pool.query(`UPDATE task_assignments SET started_at = COALESCE(started_at, NOW()) WHERE task_id = $1`, [taskId]);
        }
        if (nextStatus === "completed") {
            await pool.query(`UPDATE task_assignments SET completed_at = COALESCE(completed_at, NOW()) WHERE task_id = $1`, [taskId]);
        }

        await createTaskEvent(taskId, req.userRow.id, "task_status_changed", { status: nextStatus });
        return res.status(200).json(ok({ task: taskResponseFromRow(updatedRows[0]) }, "Task status updated"));
    } catch (error) {
        console.error("task status error:", error);
        const err = fail("Task status update failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.post("/v1/payments/create-intent", authBySessionToken, async (req, res) => {
    try {
        const taskId = String(req.body?.task_id || req.body?.taskId || "");
        if (!taskId) {
            const err = fail("Missing task_id", 400);
            return res.status(err.status).json(err.body);
        }

        const { rows: taskRows } = await pool.query(`SELECT * FROM tasks WHERE id = $1 LIMIT 1`, [taskId]);
        const task = taskRows[0];
        if (!task) {
            const err = fail("Task not found", 404);
            return res.status(err.status).json(err.body);
        }
        if (task.requester_id !== req.userRow.id) {
            const err = fail("Only requester can create payment", 403);
            return res.status(err.status).json(err.body);
        }

        const amount = Number(task.price || 0);
        const platformFee = Number(((amount * platformFeePercent) / 100).toFixed(2));
        const fakePaymentIntentId = `pi_${crypto.randomBytes(12).toString("hex")}`;

        const { rows } = await pool.query(
            `INSERT INTO payments (task_id, stripe_payment_intent_id, amount, platform_fee, status)
             VALUES ($1, $2, $3, $4, 'requires_payment_method')
             ON CONFLICT (task_id)
             DO UPDATE SET amount = EXCLUDED.amount,
                           platform_fee = EXCLUDED.platform_fee,
                           status = 'requires_payment_method',
                           stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
                           updated_at = NOW()
             RETURNING *`,
            [taskId, fakePaymentIntentId, amount, platformFee]
        );

        await createTaskEvent(taskId, req.userRow.id, "payment_intent_created", { payment_id: rows[0].id });
        return res.status(200).json(ok({
            payment: rows[0],
            client_secret: `mock_secret_${fakePaymentIntentId}`
        }, "Payment intent created (Stripe integration placeholder)"));
    } catch (error) {
        console.error("create payment error:", error);
        const err = fail("Payment create failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.post("/v1/ratings", authBySessionToken, async (req, res) => {
    try {
        const taskId = String(req.body?.task_id || req.body?.taskId || "");
        const rateeId = String(req.body?.ratee_id || req.body?.rateeId || "");
        const score = Number(req.body?.score);
        const comment = String(req.body?.comment || "");

        if (!taskId || !rateeId || !Number.isInteger(score) || score < 1 || score > 5) {
            const err = fail("Invalid rating payload", 400);
            return res.status(err.status).json(err.body);
        }

        const { rows: taskRows } = await pool.query(`SELECT * FROM tasks WHERE id = $1 LIMIT 1`, [taskId]);
        const task = taskRows[0];
        if (!task) {
            const err = fail("Task not found", 404);
            return res.status(err.status).json(err.body);
        }
        if (task.status !== "completed") {
            const err = fail("Ratings allowed only after completion", 400);
            return res.status(err.status).json(err.body);
        }

        const { rows: assignmentRows } = await pool.query(`SELECT * FROM task_assignments WHERE task_id = $1 LIMIT 1`, [taskId]);
        const assignment = assignmentRows[0];
        const participants = new Set([task.requester_id, assignment?.helper_id].filter(Boolean));
        if (!participants.has(req.userRow.id) || !participants.has(rateeId)) {
            const err = fail("Rater/ratee must be task participants", 403);
            return res.status(err.status).json(err.body);
        }

        const { rows } = await pool.query(
            `INSERT INTO ratings (task_id, rater_id, ratee_id, score, comment)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (task_id, rater_id, ratee_id)
             DO UPDATE SET score = EXCLUDED.score, comment = EXCLUDED.comment
             RETURNING *`,
            [taskId, req.userRow.id, rateeId, score, comment]
        );

        await createTaskEvent(taskId, req.userRow.id, "rating_submitted", { ratee_id: rateeId, score });
        return res.status(201).json(ok({ rating: rows[0] }, "Rating submitted"));
    } catch (error) {
        console.error("rating create error:", error);
        const err = fail("Rating submit failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.get("/v1/users/:userId/trust", authBySessionToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const { rows } = await pool.query(
            `SELECT
                COUNT(*)::int AS rating_count,
                COALESCE(ROUND(AVG(score)::numeric, 2), 0) AS avg_rating
             FROM ratings
             WHERE ratee_id = $1`,
            [userId]
        );
        return res.status(200).json(ok({
            user_id: userId,
            completed_tasks: rows[0]?.rating_count || 0,
            avg_rating: Number(rows[0]?.avg_rating || 0)
        }));
    } catch (error) {
        console.error("trust fetch error:", error);
        const err = fail("Trust fetch failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.post("/v1/auth/logout", authBySessionToken, async (req, res) => {
    try {
        await pool.query(`UPDATE sessions SET revoked_at = NOW() WHERE session_token = $1`, [req.sessionToken]);
        return res.status(200).json(ok({}, "Logged out"));
    } catch (error) {
        console.error("logout error:", error);
        const err = fail("Logout failed", 500);
        return res.status(err.status).json(err.body);
    }
});

app.use((req, res) => {
    const err = fail(`Route not found: ${req.method} ${req.path}`, 404);
    return res.status(err.status).json(err.body);
});

app.listen(port, () => {
    console.log(`canupls-backend-api running on port ${port}`);
});
