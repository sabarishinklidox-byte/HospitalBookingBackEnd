import prisma from '../prisma.js';

export const createClinicNotification = async ({
  clinicId,
  type,
  entityId,
  message,
}) => {
  return prisma.notification.create({
    data: { clinicId, type, entityId, message },
  });
};
