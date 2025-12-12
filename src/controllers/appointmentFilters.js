export const buildAppointmentWhere = (clinicId, query) => {
  const { status, date, doctor, patient, dateFrom, dateTo } = query;

  const where = {
    clinicId,
    deletedAt: null,
  };

  if (status) where.status = status;

  if (date) {
    where.slot = { date: new Date(date) };
  } else if (dateFrom || dateTo) {
    where.slot = { date: {} };
    if (dateFrom) where.slot.date.gte = new Date(dateFrom);
    if (dateTo) where.slot.date.lte = new Date(dateTo);
  }

  if (doctor) where.doctorId = doctor;

  if (patient) {
    where.user = {
      OR: [
        { name: { contains: patient, mode: 'insensitive' } },
        { phone: { contains: patient } },
      ],
    };
  }

  return where;
};