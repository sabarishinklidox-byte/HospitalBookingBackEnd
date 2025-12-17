import prisma from "../prisma.js";

// GET /admin/notifications?type=CANCELLATION&page=1&limit=10&unreadOnly=true
export const getNotifications = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { type, page = "1", limit = "10", unreadOnly } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (pageNum - 1) * limitNum;

    const where = { clinicId };
    if (type) where.type = type; // "CANCELLATION" | "RESCHEDULE"
    if (unreadOnly === "true") where.readAt = null;

    const [total, data] = await prisma.$transaction([
      prisma.notification.count({ where }),
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
    ]);

    return res.json({
      data,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Get Notifications Error:", error);
    return res.status(500).json({ error: error.message });
  }
};

// GET /admin/notifications/unread-count?type=CANCELLATION
export const getUnreadCount = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { type } = req.query;

    const where = { clinicId, readAt: null };
    if (type) where.type = type;

    const count = await prisma.notification.count({ where });
    return res.json({ count });
  } catch (error) {
    console.error("Unread Count Error:", error);
    return res.status(500).json({ error: error.message });
  }
};

// PATCH /admin/notifications/mark-all-read
// body: { type?: "CANCELLATION" | "RESCHEDULE" }
export const markAllRead = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { type } = req.body || {};

    const where = { clinicId, readAt: null };
    if (type) where.type = type;

    const result = await prisma.notification.updateMany({
      where,
      data: { readAt: new Date() },
    });

    return res.json({ updated: result.count });
  } catch (error) {
    console.error("Mark All Read Error:", error);
    return res.status(500).json({ error: error.message });
  }
};

// PATCH /admin/notifications/mark-read
// body: { ids: string[] }
export const markReadByIds = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { ids } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids[] is required" });
    }

    const result = await prisma.notification.updateMany({
      where: {
        clinicId,
        id: { in: ids },
        readAt: null,
      },
      data: { readAt: new Date() },
    });

    return res.json({ updated: result.count });
  } catch (error) {
    console.error("Mark Read By Ids Error:", error);
    return res.status(500).json({ error: error.message });
  }
};

// PATCH /admin/notifications/mark-read-by-entity
// body: { entityId: string, type?: "CANCELLATION" | "RESCHEDULE" }
// NOTE: If type is not sent, it marks ALL types for that entity as read.
export const markReadByEntity = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { entityId, type } = req.body || {};

    if (!entityId) return res.status(400).json({ error: "entityId is required" });

    const where = { clinicId, entityId, readAt: null };
    if (type) where.type = type;

    const result = await prisma.notification.updateMany({
      where,
      data: { readAt: new Date() },
    });

    return res.json({ updated: result.count });
  } catch (error) {
    console.error("Mark Read By Entity Error:", error);
    return res.status(500).json({ error: error.message });
  }
};
