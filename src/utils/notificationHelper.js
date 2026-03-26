const { sendNotification } = require('../services/notificationService');

const notifyAbsenceToParents = async (connection, id_alumno, curso, fecha, docente) => {
    try {
        // 1. Obtener tokens FCM de los padres/apoderados vinculados al alumno
        const [tokensRows] = await connection.query(
            `SELECT u.fcm_token, p.nombres, p.apellido_paterno
             FROM alumno_apoderado aa
             JOIN apoderados ap ON ap.id = aa.id_apoderado
             JOIN users u ON u.id_persona = ap.id_persona
             JOIN personas p ON p.id = ap.id_persona
             WHERE aa.id_alumno = ? AND u.fcm_token IS NOT NULL AND u.activo = 1`,
            [id_alumno]
        );

        if (!tokensRows.length) {
            console.log(`[NOTIFY-DEBUG] No se encontraron apoderados ACTIVOS con fcm_token para alumno ID: ${id_alumno}`);
            return;
        }

        console.log(`[NOTIFY-DEBUG] Se enviarán notificaciones a ${tokensRows.length} tokens.`);

        // 2. Obtener nombre del alumno
        const [alumnoRows] = await connection.query(
            `SELECT p.nombres, p.apellido_paterno 
             FROM alumnos a 
             JOIN personas p ON a.id_persona = p.id 
             WHERE a.id = ?`,
            [id_alumno]
        );

        const { decrypt } = require('./cryptoUtils');
        const nombreAlumno = alumnoRows.length ? `${decrypt(alumnoRows[0].nombres)} ${decrypt(alumnoRows[0].apellido_paterno)}` : "su hijo(a)";

        // 3. Enviar notificaciones
        const title = 'Registro de Inasistencia';
        const body = `Se ha registrado la falta de ${nombreAlumno} en el curso de ${curso}. Fecha: ${fecha}. Docente: ${docente}.`;

        for (const row of tokensRows) {
            await sendNotification(row.fcm_token, title, body, {
                type: 'absence_notification',
                id_alumno: String(id_alumno),
                fecha: String(fecha),
                curso: String(curso)
            });
        }
    } catch (error) {
        console.error('Error in notifyAbsenceToParents:', error.message);
    }
};

const notifyJustificationUpdate = async (connection, id_justificacion, estado, comentario) => {
    try {
        // Obtener datos de la justificación, el alumno y los padres
        const [rows] = await connection.query(
            `SELECT j.titulo, a.id as id_alumno, p.nombres as n_alumno
             FROM justificaciones j
             JOIN matriculas m ON j.id_matricula = m.id
             JOIN alumnos a ON m.id_alumno = a.id
             JOIN personas p ON a.id_persona = p.id
             WHERE j.id = ?`,
            [id_justificacion]
        );

        if (!rows.length) return;
        const { id_alumno, titulo, n_alumno } = rows[0];
        const { decrypt } = require('./cryptoUtils');
        const nombreAlumno = decrypt(n_alumno);

        // Obtener tokens FCM (el del alumno y el de sus padres)
        const [tokensRows] = await connection.query(
            `SELECT u.fcm_token 
             FROM users u
             JOIN alumnos a ON u.id_persona = a.id_persona
             WHERE a.id = ? AND u.fcm_token IS NOT NULL AND u.activo = 1
             UNION
             SELECT u.fcm_token
             FROM alumno_apoderado aa
             JOIN apoderados ap ON aa.id_apoderado = ap.id
             JOIN users u ON u.id_persona = ap.id_persona
             WHERE aa.id_alumno = ? AND u.fcm_token IS NOT NULL AND u.activo = 1`,
            [id_alumno, id_alumno]
        );

        if (!tokensRows.length) return;

        const title = `Justificación ${estado}`;
        const body = `Su solicitud "${titulo}" para ${nombreAlumno} ha sido ${estado.toLowerCase()}.${comentario ? ' Nota: ' + comentario : ''}`;

        for (const row of tokensRows) {
            await sendNotification(row.fcm_token, title, body, {
                type: 'justification_update',
                id_justificacion: String(id_justificacion),
                estado: estado
            });
        }
    } catch (error) {
        console.error('Error in notifyJustificationUpdate:', error.message);
    }
};

module.exports = { notifyAbsenceToParents, notifyJustificationUpdate };
