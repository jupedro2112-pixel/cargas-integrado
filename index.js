const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Middleware para interpretar JSON
app.use(express.json());

// Endpoint para recibir mensajes del webhook de Kommo
app.post('/webhook', (req, res) => {
    const incomingMessage = req.body; // Datos que Kommo manda al backend
    
    // Mostrar en los logs del servidor el mensaje recibido
    console.log('Mensaje recibido de Kommo:', incomingMessage);

    // Aquí procesas el mensaje y puedes responder de alguna manera
    res.json({ message: 'Mensaje recibido correctamente' }); // Respuesta básica
});

// Servir el backend en el puerto definido
app.listen(port, () => {
    console.log(`Servidor corriendo en http://localhost:${port}`);
});
