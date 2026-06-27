require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');
const config = require('./config');

const STATE = {
    IDLE: 'idle',
    WAITING_TITLE: 'waiting_title',
    WAITING_DEADLINE: 'waiting_deadline',
    WAITING_PROJECT: 'waiting_project',
    WAITING_PROJECT_NAME: 'waiting_project_name',
    WAITING_CONTACT_NAME: 'waiting_contact_name',
    WAITING_CONTACT_PHONE: 'waiting_contact_phone',
    WAITING_CONTACT_USERNAME: 'waiting_contact_username',
    WAITING_CONTACT_EMAIL: 'waiting_contact_email',
    WAITING_CONTACT_MESSENGER: 'waiting_contact_messenger',
    WAITING_PROJECT_TITLE: 'waiting_project_title',
    WAITING_PROJECT_CONTACT: 'waiting_project_contact',
    WAITING_PROJECT_TASK: 'waiting_project_task',
    WAITING_CONTACT_SEARCH: 'waiting_contact_search',
    // Новые состояния для редактирования задач
    WAITING_EDIT_TITLE: 'waiting_edit_title',
    WAITING_EDIT_DEADLINE: 'waiting_edit_deadline'
};

let currentState = STATE.IDLE;
let taskDraft = { title: '', deadline: null, projectId: null, editTaskId: null };
let contactDraft = { name: '', phone: null, username: null, email: null, messenger: 'Telegram' };
let projectDraft = { title: '', contactId: null };
let pendingContactAction = {
    active: false, contactId: null, waitingPhone: false,
    waitingNewProjectName: false, waitingProjectForMessage: false,
    forwardedData: { messageText: '', projectId: null },
    afterContactCreated: null,
    isHiddenProfile: false,
    hiddenProfileMessageText: ''
};

const bot = new TelegramBot(config.TOKEN, { polling: true });

// Устанавливаем команды в меню бота
bot.setMyCommands([
    { command: 'start', description: '🚀 Запустить бота' },
    { command: 'status', description: '📊 Состояние системы' },
    { command: 'new', description: '📝 Новая задача' },
    { command: 'tasks', description: '📋 Список задач' },
    { command: 'today', description: '📅 Задачи на сегодня' },
    { command: 'history', description: '📜 История задач' },
    { command: 'add_contact', description: '👤 Добавить контакт' },
    { command: 'contacts', description: '📇 Список контактов' },
    { command: 'project', description: '📁 Новый проект' },
    { command: 'backup', description: '💾 Статус бэкапов' },
    { command: 'cancel', description: '❌ Отмена' }
]).then(() => {
    console.log('✅ Меню команд установлено');
}).catch(err => {
    console.error('❌ Ошибка установки меню:', err.message);
});

bot.on('message', (msg) => {
    if (msg.from.id !== config.MY_ID) {
        bot.sendMessage(msg.chat.id, '🛑 Этот бот не настроен для вашего Telegram ID. Обратитесь к администратору.');
        return false;
    }
});


// Функция экранирования спецсимволов Markdown
function escapeMarkdown(text) {
    if (!text) return '';
    return String(text)
        .replace(/\\/g, '\\\\')  // Сначала экранируем обратный слэш
        .replace(/[_*`\[]/g, '\\$&');  // Только спецсимволы Markdown v1
}

function resetState() {
    currentState = STATE.IDLE;
    taskDraft = { title: '', deadline: null, projectId: null, editTaskId: null };
    contactDraft = { name: '', phone: null, username: null, email: null, messenger: 'Telegram' };
    projectDraft = { title: '', contactId: null };
    pendingContactAction = {
        active: false, contactId: null, waitingPhone: false,
        waitingNewProjectName: false, waitingProjectForMessage: false,
        forwardedData: { messageText: '', projectId: null },
        afterContactCreated: null,
        isHiddenProfile: false,
        hiddenProfileMessageText: ''
    };
}

function formatMinskDate(dateStr) {
    if (!dateStr) return null;
    try {
        return new Intl.DateTimeFormat('ru-RU', {
            timeZone: 'Europe/Minsk', day: '2-digit', month: '2-digit',
            year: 'numeric', hour: '2-digit', minute: '2-digit'
        }).format(new Date(dateStr));
    } catch (e) { return dateStr; }
}

function formatMinskDateShort(dateStr) {
    if (!dateStr) return null;
    try {
        return new Intl.DateTimeFormat('ru-RU', {
            timeZone: 'Europe/Minsk', day: '2-digit', month: '2-digit',
            hour: '2-digit', minute: '2-digit'
        }).format(new Date(dateStr));
    } catch (e) { return dateStr; }
}

function parseSmartDeadline(text) {
    const now = new Date(); text = text.toLowerCase().trim();
    if (text === 'сегодня') { const d = new Date(now); d.setHours(d.getHours() + 3); return d; }
    if (text === 'завтра') { const d = new Date(now); d.setDate(d.getDate() + 1); d.setUTCHours(7, 0, 0, 0); return d; }
    if (text === 'неделя' || text.includes('нед') || text.includes('вторник')) {
        const nowMinskStr = now.toLocaleString("en-US", {timeZone: "Europe/Minsk"});
        const dMinsk = new Date(nowMinskStr);
        let daysUntilTuesday = (2 - dMinsk.getDay() + 7) % 7;
        if (daysUntilTuesday === 0) daysUntilTuesday = 7;
        const d = new Date(now); d.setDate(d.getDate() + daysUntilTuesday); d.setUTCHours(7, 0, 0, 0); return d;
    }
    const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/);
    if (dateMatch) {
        const day = parseInt(dateMatch[1]), month = parseInt(dateMatch[2]) - 1, year = dateMatch[3] ? parseInt(dateMatch[3]) : now.getFullYear();
        const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
        const hour = timeMatch ? parseInt(timeMatch[1]) : 10, minute = timeMatch ? parseInt(timeMatch[2]) : 0;
        return new Date(Date.UTC(year, month, day, hour - 3, minute, 0));
    }
    return null;
}

async function getActiveProjects() {
    const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=50`, {
        headers: { 'xc-token': config.NOCO_TOKEN }
    });
    return res.data.list.filter(p => p['Активно'] === 'Активно');
}

// Нормализация телефона для поиска (приводим к формату 375XXXXXXXXX)
function normalizePhone(p) {
    if (!p) return '';
    let digits = String(p).replace(/\D/g, '');
    if (digits.startsWith('80')) digits = '375' + digits.substring(2);
    else if (digits.startsWith('0') && digits.length === 10) digits = '375' + digits.substring(1);
    return digits;
}

async function findDuplicateContact(tgId, phone, username) {
    const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=200`, {
        headers: { 'xc-token': config.NOCO_TOKEN }
    });
    const contacts = res.data.list;

    // 1. TG ID - СТРОГОЕ СОВПАДЕНИЕ
    if (tgId) {
        const match = contacts.find(c => String(c['TG ID'] || '') === String(tgId));
        if (match) return match;
    }

    // 2. Телефон - УМНОЕ СРАВНЕНИЕ (последние 9 цифр для РБ)
    if (phone) {
        const normPhone = normalizePhone(phone);
        const targetLast9 = normPhone.slice(-9);

        if (targetLast9.length === 9) {
            const match = contacts.find(c => {
                const cNormPhone = normalizePhone(c['Телефон']);
                return cNormPhone.slice(-9) === targetLast9;
            });
            if (match) return match;
        } else if (targetLast9.length >= 7) {
            // Фоллбэк для коротких номеров
            const match = contacts.find(c => {
                const cNormPhone = normalizePhone(c['Телефон']);
                return cNormPhone.endsWith(targetLast9);
            });
            if (match) return match;
        }
    }

    // 3. Username - СТРОГОЕ СОВПАДЕНИЕ
    if (username) {
        const cleanUsername = username.replace('@', '').toLowerCase();
        const match = contacts.find(c => {
            const cLink = String(c['Ссылка'] || '').toLowerCase();
            return cLink === `https://t.me/${cleanUsername}` || cLink.endsWith(`/${cleanUsername}`);
        });
        if (match) return match;
    }

    return null;
}

async function startContactWizard(chatId) {
    currentState = STATE.WAITING_CONTACT_NAME;
    contactDraft = { name: '', phone: null, username: null, email: null, messenger: 'Telegram' };
    await bot.sendMessage(chatId, `👤 *Добавление нового контакта*\n\nШаг 1️⃣ из 5\n\n✏️ *Напиши имя контакта:*`, { parse_mode: 'Markdown' });
}

async function startProjectWizard(chatId) {
    currentState = STATE.WAITING_PROJECT_TITLE;
    projectDraft = { title: '', contactId: null };
    await bot.sendMessage(chatId, `🚀 *Создание нового проекта*\n\nШаг 1️⃣ из 3\n\n✏️ *Напиши название проекта:*`, { parse_mode: 'Markdown' });
}

async function showContactSelectionForProject(chatId) {
    currentState = STATE.WAITING_PROJECT_CONTACT;
    try {
        const contactsRes = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=5&sort=-Id`, {
            headers: { 'xc-token': config.NOCO_TOKEN }
        });
        const recentContacts = contactsRes.data.list;
        let text = `👥 *Шаг 2️⃣ из 3*\n\n*Выбери клиента для проекта:*\n\n`;
        if (recentContacts.length > 0) text += `🕐 *Последние добавленные:*\n`;
        const inlineKeyboard = [];
        recentContacts.forEach(c => {
            const phone = c['Телефон'] ? ` (${escapeMarkdown(c['Телефон'])})` : '';
            inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `proj_contact_${c.Id}` }]);
        });
        inlineKeyboard.push([{ text: '🔍 Найти по имени или телефону...', callback_data: 'proj_search_contact' }]);
        inlineKeyboard.push([{ text: '➕ Создать нового клиента', callback_data: 'proj_new_contact' }]);
        inlineKeyboard.push([{ text: '⏭️ Без клиента', callback_data: 'proj_no_contact' }]);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка получения контактов: ${err.message}`);
        resetState();
    }
}

async function searchContacts(chatId, query) {
    try {
        const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=100`, {
            headers: { 'xc-token': config.NOCO_TOKEN }
        });
        const allContacts = res.data.list;
        const q = query.toLowerCase().trim();
        const found = allContacts.filter(c => {
            const name = String(c['Имя'] || '').toLowerCase();
            const phone = String(c['Телефон'] || '').toLowerCase();
            const link = String(c['Ссылка'] || '').toLowerCase();
            return name.includes(q) || phone.includes(q) || link.includes(q);
        });
        if (found.length === 0) {
            const inlineKeyboard = [
                [{ text: '🔍 Попробовать другой запрос', callback_data: 'proj_search_contact' }],
                [{ text: '➕ Создать нового клиента', callback_data: 'proj_new_contact' }],
                [{ text: '⏭️ Без клиента', callback_data: 'proj_no_contact' }]
            ];
            await bot.sendMessage(chatId, `❌ Ничего не найдено по запросу "*${query}*"`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            return;
        }
        let text = `🔍 *Найдено ${found.length} контакт(ов):*\n\n`;
        const inlineKeyboard = [];
        found.slice(0, 10).forEach(c => {
            const phone = c['Телефон'] ? ` 📱${escapeMarkdown(c['Телефон'])}` : '';
            inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `proj_contact_${c.Id}` }]);
        });
        inlineKeyboard.push([{ text: '🔍 Уточнить поиск...', callback_data: 'proj_search_contact' }]);
        inlineKeyboard.push([{ text: '➕ Создать нового клиента', callback_data: 'proj_new_contact' }]);
        inlineKeyboard.push([{ text: '⏭️ Без клиента', callback_data: 'proj_no_contact' }]);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка поиска: ${err.message}`);
    }
}

async function showProjectSelectionForContact(chatId, contactId) {
    pendingContactAction = { ...pendingContactAction, active: true, contactId: contactId, waitingPhone: false, waitingNewProjectName: false, waitingProjectForMessage: false };
    currentState = STATE.IDLE;
    const text = `🔗 *К какому проекту привязать?*\n\n1️⃣ Нажми "➕ Создать новый проект" (рекомендуется)\n2️⃣ Или "❌ Без проекта"`;
    const inlineKeyboard = [
        [{ text: '➕ Создать новый проект 🚀', callback_data: 'proj_new_for_contact' }],
        [{ text: '❌ Без проекта', callback_data: 'proj_none_contact' }]
    ];
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
}

async function showProjectSelectionForTask(chatId) {
    try {
        const projects = await getActiveProjects();
        let text = `📅 *Срок:* ${taskDraft.deadline ? formatMinskDate(taskDraft.deadline) : 'Без срока'}\n\n🚀 *К какому проекту привязать?*`;
        const inlineKeyboard = projects.map(p => [{ text: `${escapeMarkdown(p['Что делаем?'])} (ID:${p.Id})`, callback_data: `project_${p.Id}` }]);
        inlineKeyboard.push([{ text: '➕ Создать новый проект', callback_data: 'create_new_project_for_task' }]);
        inlineKeyboard.push([{ text: '❌ Без проекта', callback_data: 'project_none' }]);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); resetState(); }
}

// ================== НОВОЕ: СПИСОК ЗАДАЧ НА СЕГОДНЯ ==================
async function sendTodayTasks(chatId) {
    try {
        const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}?limit=50`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const activeTasks = res.data.list.filter(t => !t['Готово']);
        
        // Фильтруем задачи на сегодня (по минскому времени)
        const nowMinsk = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Minsk"}));
        const todayStart = new Date(nowMinsk); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(nowMinsk); todayEnd.setHours(23, 59, 59, 999);
        
        const todayTasks = activeTasks.filter(t => {
            if (!t['Когда делаем']) return false;
            const taskDate = new Date(t['Когда делаем']);
            return taskDate >= todayStart && taskDate <= todayEnd;
        });
        
        let text = `📅 *Задачи на сегодня (${todayStart.toLocaleDateString('ru-RU')})*\n\n`;
        
        if (todayTasks.length === 0) {
            text += '🎉 На сегодня задач нет!';
        } else {
            todayTasks.sort((a, b) => new Date(a['Когда делаем']) - new Date(b['Когда делаем']));
            todayTasks.forEach(t => {
                text += `🔹 *#${t.Id}* ${escapeMarkdown(t['Что делаем?'])}\n   🕐 ${formatMinskDateShort(t['Когда делаем'])}\n\n`;
            });
        }
        
        const inlineKeyboard = todayTasks.map(t => [{ text: `✅ Закрыть #${t.Id}`, callback_data: `done_${t.Id}` }]);
        inlineKeyboard.push([{ text: '📋 Все задачи', callback_data: 'refresh_tasks' }]);
        
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
    }
}

// ================== НОВОЕ: ИСТОРИЯ ЗАДАЧ ==================
async function sendTaskHistory(chatId) {
    try {
        const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}?limit=100`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const doneTasks = res.data.list.filter(t => t['Готово']);
        
        // Фильтруем задачи за последние 7 дней
        const now = new Date();
        const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
        
        const recentDone = doneTasks.filter(t => {
            const updated = t['UpdatedAt'] ? new Date(t['UpdatedAt']) : null;
            return updated && updated >= weekAgo;
        });
        
        let text = `📜 *История задач (последние 7 дней)*\n\n`;
        
        if (recentDone.length === 0) {
            text += '📭 За последнюю неделю нет выполненных задач.';
        } else {
            recentDone.sort((a, b) => new Date(b['UpdatedAt']) - new Date(a['UpdatedAt']));
            text += `✅ Выполнено: *${recentDone.length}*\n\n`;
            recentDone.forEach(t => {
                const date = t['UpdatedAt'] ? formatMinskDate(t['UpdatedAt']) : 'неизвестно';
                text += `✅ *#${t.Id}* ${escapeMarkdown(t['Что делаем?'])}\n   📅 Закрыта: ${escapeMarkdown(date)}\n\n`;
            });
        }
        
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
    }
}

// ================== НОВОЕ: НАЧАЛО РЕДАКТИРОВАНИЯ ЗАДАЧИ ==================
async function startEditTask(chatId, taskId) {
    try {
        const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const task = res.data;
        
        taskDraft.editTaskId = taskId;
        taskDraft.title = task['Что делаем?'];
        taskDraft.deadline = task['Когда делаем'] ? new Date(task['Когда делаем']) : null;
        
        currentState = STATE.WAITING_EDIT_TITLE;
        
        const inlineKeyboard = [
            [{ text: '📅 Изменить срок', callback_data: 'edit_deadline' }],
            [{ text: '❌ Отмена', callback_data: 'edit_cancel' }]
        ];
        
        await bot.sendMessage(chatId, 
            `✏️ *Редактирование задачи #${taskId}*\n\n📝 *Текущее название:*\n${escapeMarkdown(task['Что делаем?'])}\n📅 *Срок:* ${task['Когда делаем'] ? formatMinskDate(task['Когда делаем']) : 'Без срока'}\n\n✏️ *Напиши новое название* (или оставь как есть, нажав "📅 Изменить срок"):`, 
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
    }
}

bot.onText(/\/skip/, async (msg) => {
    const chatId = msg.chat.id;
    if (currentState === STATE.WAITING_CONTACT_NAME) {
        // Если есть известное имя из пересылки — используем его
        const knownName = pendingContactAction.forwardedData?.contactName;
        if (knownName) {
            contactDraft.name = knownName;
            currentState = STATE.WAITING_CONTACT_PHONE;
            bot.sendMessage(chatId, `✅ Имя: *${escapeMarkdown(knownName)}*\n\nШаг 2️⃣ из 5\n\n📱 *Напиши номер телефона* (или /skip):`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, '❌ Имя обязательно!');
        }
        return;
    }
    if (currentState === STATE.WAITING_CONTACT_PHONE) {
        contactDraft.phone = null;
        currentState = STATE.WAITING_CONTACT_USERNAME;
        
        // Если есть известный username из пересылки — показываем его
        const knownUsername = pendingContactAction.forwardedData?.username;
        if (knownUsername) {
            bot.sendMessage(chatId, `⏭️ Телефон пропущен.\n\n🔗 *Username:* @${escapeMarkdown(knownUsername)}\n\n💡 *Введи новый username* или /skip чтобы использовать указанный.`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, '⏭️ Телефон пропущен.\n\n🔗 *Введи Telegram username* (например, @vasiok) или /skip:', { parse_mode: 'Markdown' });
        }
        return;
    }
    if (currentState === STATE.WAITING_CONTACT_USERNAME) {
        // Если есть известный username из пересылки — используем его
        const knownUsername = pendingContactAction.forwardedData?.username;
        if (knownUsername) {
            contactDraft.username = knownUsername;
        } else {
            contactDraft.username = null;
        }
        currentState = STATE.WAITING_CONTACT_EMAIL;
        bot.sendMessage(chatId, `⏭️ Username: ${contactDraft.username ? '@' + escapeMarkdown(contactDraft.username) : 'пропущен'}\n\n📧 *Напиши E-mail* (или /skip):`, { parse_mode: 'Markdown' }); return;
    }
    if (currentState === STATE.WAITING_CONTACT_EMAIL) {
        contactDraft.email = null;
        currentState = STATE.WAITING_CONTACT_MESSENGER;
        const inlineKeyboard = [
            [{ text: '💬 Telegram', callback_data: 'messenger_Telegram' }],
            [{ text: '📱 Viber', callback_data: 'messenger_Viber' }],
            [{ text: '🛒 Куфар', callback_data: 'messenger_Куфар' }],
            [{ text: '⏭️ Пропустить', callback_data: 'messenger_skip' }]
        ];
        bot.sendMessage(chatId, '⏭️ E-mail пропущен.\n\n💬 *Выбери мессенджер:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }); return;
    }
    if (currentState === STATE.WAITING_DEADLINE) {
        taskDraft.deadline = null; currentState = STATE.WAITING_PROJECT;
        showProjectSelectionForTask(chatId); return;
    }
    if (currentState === STATE.WAITING_EDIT_DEADLINE) {
        // Пропуск срока при редактировании - сохраняем без изменений
        try {
            await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}/${taskDraft.editTaskId}`, { 'Когда делаем': null }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `✅ Задача #${taskDraft.editTaskId} обновлена! Срок убран.`);
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
        resetState();
        return;
    }
    if (pendingContactAction.active && pendingContactAction.waitingPhone) {
        pendingContactAction.waitingPhone = false;
        bot.sendMessage(chatId, '⏭️ Телефон пропущен.');
        showProjectSelectionForContact(chatId, pendingContactAction.contactId); return;
    }
    bot.sendMessage(chatId, '⚠️ Сейчас нечего пропускать.');
});

bot.on('text', async (msg) => {
    const text = msg.text.trim();
    const chatId = msg.chat.id;

    if (msg.forward_date) return;

    if (text.startsWith('/') && currentState !== STATE.IDLE) {
        if (text === '/skip' || text === '/cancel') return;
        resetState();
    }

    // ================== НОВОЕ: РЕДАКТИРОВАНИЕ ЗАДАЧИ ==================
    if (currentState === STATE.WAITING_EDIT_TITLE) {
        if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Название слишком короткое.');
        taskDraft.title = text;
        currentState = STATE.WAITING_EDIT_DEADLINE;
        bot.sendMessage(chatId, `✅ Новое название: *${text}*\n\n📅 *Введи новый срок* (или /skip чтобы оставить без изменений):\n• сегодня\n• завтра\n• неделя\n• 17.06 14:00`, { parse_mode: 'Markdown' });
        return;
    }
    
    if (currentState === STATE.WAITING_EDIT_DEADLINE) {
        const parsed = parseSmartDeadline(text);
        if (parsed) {
            taskDraft.deadline = parsed;
            try {
                await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}/${taskDraft.editTaskId}`, { 
                    'Что делаем?': taskDraft.title, 
                    'Когда делаем': parsed.toISOString() 
                }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                bot.sendMessage(chatId, `✅ *Задача #${taskDraft.editTaskId} обновлена!*\n\n📝 ${taskDraft.title}\n📅 ${formatMinskDate(parsed)}`, { parse_mode: 'Markdown' });
            } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
            resetState();
        } else {
            bot.sendMessage(chatId, '❌ Не понял дату. Формат: "сегодня", "завтра", "неделя" или 17.06 14:00');
        }
        return;
    }

    if (currentState === STATE.WAITING_CONTACT_SEARCH) {
        await searchContacts(chatId, text);
        currentState = STATE.WAITING_PROJECT_CONTACT;
        return;
    }

    if (currentState === STATE.WAITING_PROJECT_TITLE) {
        if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Название слишком короткое.');
        projectDraft.title = text;
        showContactSelectionForProject(chatId);
        return;
    }

    if (currentState === STATE.WAITING_PROJECT_TASK) {
        taskDraft.title = text;
        console.log(`📝 WAITING_PROJECT_TASK: title=${text}, projectId=${taskDraft.projectId}`);
        currentState = STATE.WAITING_DEADLINE;
        bot.sendMessage(chatId, `📝 *Задача: ${text}*\n\n⏰ *Когда нужно сделать?*\n• сегодня\n• завтра\n• неделя\nИли /skip`, { parse_mode: 'Markdown' });
        return;
    }

    if (currentState === STATE.WAITING_CONTACT_NAME) {
        if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Имя слишком короткое.');
        contactDraft.name = text;
        currentState = STATE.WAITING_CONTACT_PHONE;
        bot.sendMessage(chatId, `✅ Имя: *${text}*\n\nШаг 2️⃣ из 5\n\n📱 *Напиши номер телефона* (или /skip):`, { parse_mode: 'Markdown' });
        return;
    }

    if (currentState === STATE.WAITING_CONTACT_PHONE) {
        contactDraft.phone = /[\d\+\-\(\)\s]{7,}/.test(text) ? text.trim() : null;
        
        if (contactDraft.phone) {
            const duplicate = await findDuplicateContact(null, contactDraft.phone, null);
            if (duplicate) {
                const inlineKeyboard = [
                    [{ text: '✅ Использовать существующий', callback_data: 'use_existing_contact' }],
                    [{ text: '➕ Всё равно создать нового', callback_data: 'create_new_anyway' }]
                ];
                bot.sendMessage(chatId, `⚠️ *Контакт с таким номером уже есть!*\n\n👤 *${escapeMarkdown(duplicate['Имя'])}*\n📱 ${escapeMarkdown(duplicate['Телефон'])}\n\nЧто делаем?`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
                pendingContactAction.duplicateContact = duplicate;
                pendingContactAction.waitingDuplicateResolve = true;
                currentState = STATE.IDLE;
                return;
            }
        }
        
        currentState = STATE.WAITING_CONTACT_USERNAME;
        
        // Если есть известный username из пересылки — показываем его
        const knownUsername = pendingContactAction.forwardedData?.username;
        if (knownUsername) {
            bot.sendMessage(chatId, `✅ Телефон: *${contactDraft.phone || 'пропущен'}*\n\nШаг 3️⃣ из 5\n\n🔗 *Username:* @${escapeMarkdown(knownUsername)}\n\n💡 *Введи новый username* или /skip чтобы использовать указанный.`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, `✅ Телефон: *${contactDraft.phone || 'пропущен'}*\n\nШаг 3️⃣ из 5\n\n🔗 *Введи Telegram username* (например, @vasiok) или /skip:`, { parse_mode: 'Markdown' });
        }
        return;
    }

    if (currentState === STATE.WAITING_CONTACT_USERNAME) {
        const usernameMatch = text.match(/@?([a-zA-Z0-9_]{3,})/);
        if (usernameMatch) {
            contactDraft.username = usernameMatch[1];
            
            const duplicate = await findDuplicateContact(null, null, contactDraft.username);
            if (duplicate) {
                const inlineKeyboard = [
                    [{ text: '✅ Использовать существующий', callback_data: 'use_existing_contact' }],
                    [{ text: '➕ Всё равно создать нового', callback_data: 'create_new_anyway_username' }]
                ];
                bot.sendMessage(chatId, `⚠️ *Контакт с таким username уже есть!*\n\n👤 *${escapeMarkdown(duplicate['Имя'])}*\n🔗 ${duplicate['Ссылка']}\n\nЧто делаем?`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
                pendingContactAction.duplicateContact = duplicate;
                pendingContactAction.waitingDuplicateResolve = true;
                currentState = STATE.IDLE;
                return;
            }
            
            currentState = STATE.WAITING_CONTACT_EMAIL;
            bot.sendMessage(chatId, `✅ Username: *@${contactDraft.username}*\n🔗 Ссылка: https://t.me/${contactDraft.username}\n\nШаг 4️⃣ из 5\n\n📧 *Напиши E-mail* (или /skip):`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, '❌ Не похоже на username. Формат: @vasiok или vasiok. Или /skip.');
        }
        return;
    }

    if (currentState === STATE.WAITING_CONTACT_EMAIL) {
        contactDraft.email = (text.includes('@') && text.includes('.')) ? text.trim() : null;
        currentState = STATE.WAITING_CONTACT_MESSENGER;
        const inlineKeyboard = [
            [{ text: '💬 Telegram', callback_data: 'messenger_Telegram' }],
            [{ text: '📱 Viber', callback_data: 'messenger_Viber' }],
            [{ text: '🛒 Куфар', callback_data: 'messenger_Куфар' }],
            [{ text: '⏭️ Пропустить', callback_data: 'messenger_skip' }]
        ];
        bot.sendMessage(chatId, `✅ E-mail: *${contactDraft.email || 'пропущен'}*\n\nШаг 5️⃣ из 5\n\n💬 *Выбери мессенджер:*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        return;
    }

    if (currentState === STATE.WAITING_PROJECT_NAME) {
        try {
            const res = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}`, {
                'Что делаем?': text, 'Статус': 'Обсуждение'
            }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `🚀 *Проект создан!*\n📝 ${text}\n🆔 ID: ${res.data.Id}`, { parse_mode: 'Markdown' });
            if (taskDraft.projectId === 'pending_new') {
                const payload = { 'Что делаем?': taskDraft.title, 'Готово': false };
                if (taskDraft.deadline) payload['Когда делаем'] = taskDraft.deadline.toISOString();
                payload['Какой проект'] = [{ Id: res.data.Id }];
                const taskRes = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
                bot.sendMessage(chatId, `✅ Задача создана и привязана к проекту!\n📝 *${taskDraft.title}*\n🆔 Задача ID: ${taskRes.data.Id}`, { parse_mode: 'Markdown' });
            }
            resetState();
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); resetState(); }
        return;
    }

    if (text.startsWith('/')) return;

    if (currentState === STATE.WAITING_TITLE) {
        taskDraft.title = text; currentState = STATE.WAITING_DEADLINE;
        bot.sendMessage(chatId, `📝 *Принято: ${text}*\n\n⏰ *Когда нужно сделать?*\n• сегодня\n• завтра\n• неделя\nИли /skip`, { parse_mode: 'Markdown' });
        return;
    }

    if (currentState === STATE.WAITING_DEADLINE) {
        const parsed = parseSmartDeadline(text);
        if (parsed) { 
            taskDraft.deadline = parsed; 
            
            // Если это задача для нового проекта (projectId уже установлен)
            if (taskDraft.projectId && typeof taskDraft.projectId === 'number') {
                // Создаём задачу сразу
                try {
                    const payload = { 'Что делаем?': taskDraft.title, 'Готово': false };
                    if (taskDraft.deadline) payload['Когда делаем'] = taskDraft.deadline.toISOString();
                    payload['Какой проект'] = [{ Id: taskDraft.projectId }];
                    const taskRes = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
                    bot.sendMessage(chatId, `✅ *Задача создана и привязана к проекту!*\n📝 *${taskDraft.title}*\n🆔 Задача ID: ${taskRes.data.Id}`, { parse_mode: 'Markdown' });
                    resetState();
                } catch (err) {
                    bot.sendMessage(chatId, `❌ Ошибка создания задачи: ${err.message}`);
                    resetState();
                }
            } else {
                // Обычный поток: выбор проекта
                currentState = STATE.WAITING_PROJECT; 
                showProjectSelectionForTask(chatId);
            }
        } else { 
            bot.sendMessage(chatId, '❌ Не понял дату.'); 
        }
        return;
    }

    if (pendingContactAction.active && pendingContactAction.waitingNewProjectName) {
        try {
            const projRes = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}`, {
                'Что делаем?': text, 'Статус': 'Обсуждение', 'Контакт': pendingContactAction.contactId
            }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `🚀 *Проект создан и привязан!*\n📝 ${text}\n🆔 ID: ${projRes.data.Id}`, { parse_mode: 'Markdown' });
            resetState();
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); resetState(); }
        return;
    }

    if (pendingContactAction.active && pendingContactAction.waitingPhone) {
        if (/[\d\+\-\(\)\s]{7,}/.test(text)) {
            await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${pendingContactAction.contactId}`, { 'Телефон': text }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `✅ Телефон *${text}* сохранен! 📱`, { parse_mode: 'Markdown' });
            pendingContactAction.waitingPhone = false;
            showProjectSelectionForContact(chatId, pendingContactAction.contactId);
        } else { bot.sendMessage(chatId, '❌ Не похоже на телефон.'); }
        return;
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = msg.chat.id;

    try {
        // ================== НОВОЕ: РЕДАКТИРОВАНИЕ ЗАДАЧИ ==================
        if (data.startsWith('edit_')) {
            const taskId = parseInt(data.split('_')[1]);
            
            if (data === 'edit_deadline') {
                bot.answerCallbackQuery(callbackQuery.id);
                currentState = STATE.WAITING_EDIT_DEADLINE;
                bot.sendMessage(chatId, `📅 *Введи новый срок для задачи #${taskId}:*\n\n• сегодня\n• завтра\n• неделя\n• 17.06 14:00\n\nИли /skip чтобы убрать срок.`, { parse_mode: 'Markdown' });
                return;
            }
            
            if (data === 'edit_cancel') {
                bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
                bot.sendMessage(chatId, '❌ Редактирование отменено.');
                resetState();
                return;
            }
            
            // edit_{id} - начало редактирования
            bot.answerCallbackQuery(callbackQuery.id);
            await startEditTask(chatId, taskId);
            return;
        }
        
        // ================== НОВОЕ: КОМАНДА /today из меню ==================
        if (data === 'show_today') {
            bot.answerCallbackQuery(callbackQuery.id);
            await sendTodayTasks(chatId);
            return;
        }
        
        // ================== НОВОЕ: ИСТОРИЯ ЗАДАЧ ==================
        if (data === 'show_history') {
            bot.answerCallbackQuery(callbackQuery.id);
            await sendTaskHistory(chatId);
            return;
        }

        if (data === 'use_existing_contact') {
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Используем существующий' });
            const duplicate = pendingContactAction.duplicateContact;
            pendingContactAction.waitingDuplicateResolve = false;
            
            if (pendingContactAction.isHiddenProfile && pendingContactAction.hiddenProfileMessageText) {
                const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
                const newEntry = `[${timestamp}] Пересылка (скрытый профиль)\n💬 "${pendingContactAction.hiddenProfileMessageText}"`;
                const current = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${duplicate.Id}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
                const oldExtra = String(current.data['Доп. информация'] || '').trim();
                const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
                await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${duplicate.Id}`, { 'Доп. информация': newExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                bot.sendMessage(chatId, `✅ Текст сообщения добавлен в карточку *${escapeMarkdown(duplicate['Имя'])}*`, { parse_mode: 'Markdown' });
                pendingContactAction.isHiddenProfile = false;
                pendingContactAction.hiddenProfileMessageText = '';
            }
            
            showProjectSelectionForContact(chatId, duplicate.Id);
            return;
        }
        
        if (data === 'create_new_anyway' || data === 'create_new_anyway_username') {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Создаём нового' });
            pendingContactAction.waitingDuplicateResolve = false;
            if (data === 'create_new_anyway_username') {
                currentState = STATE.WAITING_CONTACT_EMAIL;
                bot.sendMessage(chatId, `📧 *Напиши E-mail* (или /skip):`, { parse_mode: 'Markdown' });
            } else {
                currentState = STATE.WAITING_CONTACT_USERNAME;
                bot.sendMessage(chatId, `🔗 *Введи Telegram username* (например, @vasiok) или /skip:`, { parse_mode: 'Markdown' });
            }
            return;
        }

        if (data.startsWith('proj_contact_')) {
            projectDraft.contactId = parseInt(data.split('_')[2]);
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Клиент выбран!' });
            const inlineKeyboard = [
                [{ text: '✅ Да, создать задачу', callback_data: 'proj_task_yes' }],
                [{ text: '❌ Нет, завершить', callback_data: 'proj_task_no' }]
            ];
            bot.sendMessage(chatId, `👥 Клиент выбран!\n\n📋 *Шаг 3️⃣ из 3*\n\n*Хочешь сразу создать задачу?*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            return;
        }

        if (data === 'proj_search_contact') {
            bot.answerCallbackQuery(callbackQuery.id);
            currentState = STATE.WAITING_CONTACT_SEARCH;
            bot.sendMessage(chatId, '🔍 *Введи часть имени, номер телефона или username:*', { parse_mode: 'Markdown' });
            return;
        }

        if (data === 'proj_new_contact') {
            bot.answerCallbackQuery(callbackQuery.id);
            startContactWizard(chatId);
            pendingContactAction.afterContactCreated = 'back_to_project';
            return;
        }

        if (data === 'proj_no_contact') {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Ок, без клиента' });
            projectDraft.contactId = null;
            const inlineKeyboard = [
                [{ text: '✅ Да, создать задачу', callback_data: 'proj_task_yes' }],
                [{ text: '❌ Нет, завершить', callback_data: 'proj_task_no' }]
            ];
            bot.sendMessage(chatId, `📋 *Шаг 3️⃣ из 3*\n\n*Хочешь сразу создать задачу?*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            return;
        }

        if (data === 'proj_task_yes') {
            bot.answerCallbackQuery(callbackQuery.id);
            
            // СНАЧАЛА создаём проект
            try {
                const payload = { 'Что делаем?': projectDraft.title, 'Статус': 'Обсуждение' };
                if (projectDraft.contactId) payload['Контакт'] = projectDraft.contactId;
                const res = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
                
                // Сохраняем ID созданного проекта
                taskDraft.projectId = res.data.Id;
                console.log(`✅ Проект создан, projectId=${res.data.Id}, type=${typeof res.data.Id}`);
                
                bot.sendMessage(chatId, `🚀 *Проект создан!*\n📝 ${projectDraft.title}\n🆔 ID: ${res.data.Id}\n\n📝 *Теперь напиши название задачи:*`, { parse_mode: 'Markdown' });
                
                currentState = STATE.WAITING_PROJECT_TASK;
            } catch (err) {
                bot.sendMessage(chatId, `❌ Ошибка создания проекта: ${err.message}`);
                resetState();
            }
            return;
        }

        if (data === 'proj_task_no') {
            bot.answerCallbackQuery(callbackQuery.id);
            const payload = { 'Что делаем?': projectDraft.title, 'Статус': 'Обсуждение' };
            if (projectDraft.contactId) payload['Контакт'] = projectDraft.contactId;
            const res = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `🚀 *Проект создан!*\n📝 ${projectDraft.title}\n🆔 ID: ${res.data.Id}`, { parse_mode: 'Markdown' });
            resetState();
            return;
        }

        if (data.startsWith('messenger_')) {
            const messenger = data.replace('messenger_', '');
            contactDraft.messenger = messenger === 'skip' ? 'Telegram' : messenger;
            bot.answerCallbackQuery(callbackQuery.id, { text: `✅ Выбрано: ${contactDraft.messenger}` });

            const payload = { 'Имя': contactDraft.name, 'Мессенджер': contactDraft.messenger };
            if (contactDraft.phone) payload['Телефон'] = contactDraft.phone;
            if (contactDraft.username) payload['Ссылка'] = `https://t.me/${contactDraft.username}`;
            if (contactDraft.email) payload['E-mail'] = contactDraft.email;
            if (pendingContactAction.forwardedData?.tgId) payload['TG ID'] = String(pendingContactAction.forwardedData.tgId);

            const res = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const contactId = res.data.Id;

            let msgText = `✅ *Контакт создан!*\n\n👤 *${contactDraft.name}*\n📱 ${contactDraft.phone || 'не указан'}\n🔗 ${contactDraft.username ? `https://t.me/${contactDraft.username}` : 'не указан'}\n🆔 ID: ${contactId}`;
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });

            if (pendingContactAction.isHiddenProfile && pendingContactAction.hiddenProfileMessageText) {
                const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
                const newEntry = `[${timestamp}] Пересылка (скрытый профиль)\n💬 "${pendingContactAction.hiddenProfileMessageText}"`;
                const current = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
                const oldExtra = String(current.data['Доп. информация'] || '').trim();
                const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
                await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { 'Доп. информация': newExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                bot.sendMessage(chatId, `📄 Текст сообщения сохранён в "Доп. информацию" контакта.`, { parse_mode: 'Markdown' });
                pendingContactAction.isHiddenProfile = false;
                pendingContactAction.hiddenProfileMessageText = '';
            }

            if (pendingContactAction.afterContactCreated === 'back_to_project') {
                projectDraft.contactId = contactId;
                pendingContactAction.afterContactCreated = null;
                const inlineKeyboard = [
                    [{ text: '✅ Да, создать задачу', callback_data: 'proj_task_yes' }],
                    [{ text: '❌ Нет, завершить', callback_data: 'proj_task_no' }]
                ];
                bot.sendMessage(chatId, `📋 *Шаг 3️⃣ из 3*\n\n*Хочешь сразу создать задачу?*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            } else {
                showProjectSelectionForContact(chatId, contactId);
            }
            return;
        }

        if (data.startsWith('done_')) {
            await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}/${parseInt(data.split('_')[1])}`, { 'Готово': true }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Задача закрыта!' });
            await sendTaskList(chatId, msg.message_id);
            return;
        }
        if (data === 'refresh_tasks') { bot.answerCallbackQuery(callbackQuery.id); await sendTaskList(chatId, msg.message_id); return; }
        if (data === 'start_new_task') {
            bot.answerCallbackQuery(callbackQuery.id); resetState(); currentState = STATE.WAITING_TITLE;
            bot.sendMessage(chatId, '📝 *Что нужно сделать?*', { parse_mode: 'Markdown' }); return;
        }

        if (data.startsWith('project_')) {
            const projectId = parseInt(data.split('_')[1]);
            const payload = { 'Что делаем?': taskDraft.title, 'Готово': false };
            if (taskDraft.deadline) payload['Когда делаем'] = taskDraft.deadline.toISOString();
            if (projectId) payload['Какой проект'] = [{ Id: projectId }];
            const res = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Задача создана!' });
            bot.sendMessage(chatId, `✅ Задача создана!\n📝 *${taskDraft.title}*\n📅 ${taskDraft.deadline ? formatMinskDate(taskDraft.deadline) : 'Без срока'}\n🆔 ID: ${res.data.Id}`, { parse_mode: 'Markdown' });
            resetState(); return;
        }
        if (data === 'project_none') {
            const payload = { 'Что делаем?': taskDraft.title, 'Готово': false };
            if (taskDraft.deadline) payload['Когда делаем'] = taskDraft.deadline.toISOString();
            const res = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Задача создана!' });
            bot.sendMessage(chatId, `✅ Задача создана!\n📝 *${taskDraft.title}*\n📅 ${taskDraft.deadline ? formatMinskDate(taskDraft.deadline) : 'Без срока'}\n🆔 ID: ${res.data.Id}`, { parse_mode: 'Markdown' });
            resetState(); return;
        }
        if (data === 'create_new_project_for_task') {
            bot.answerCallbackQuery(callbackQuery.id);
            currentState = STATE.WAITING_PROJECT_NAME;
            taskDraft.projectId = 'pending_new';
            bot.sendMessage(chatId, '🚀 *Напиши название нового проекта для задачи:*', { parse_mode: 'Markdown' });
            return;
        }

        if (data === 'show_contacts') {
            bot.answerCallbackQuery(callbackQuery.id);
            const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=30`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            let message = `📇 *Контакты (${res.data.list.length})*\n\n`;
            if (res.data.list.length === 0) message += '📭 Пусто.';
            else res.data.list.forEach(c => { 
                const link = c['Ссылка'] ? `\n 🔗 ${c['Ссылка']}` : '';
                message += `👤 *${escapeMarkdown(c['Имя'])}*\n 📱 ${c['Телефон'] || 'нет'}${link}\n\n`; 
            });
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }); return;
        }
        if (data === 'show_projects') {
            bot.answerCallbackQuery(callbackQuery.id);
            const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=30`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const active = res.data.list.filter(p => p['Активно'] === 'Активно');
            let message = `🚀 *Активные проекты (${active.length})*\n\n`;
            if (active.length === 0) message += '📭 Пусто.';
            else active.forEach(p => { message += `🔹 *${escapeMarkdown(p['Что делаем?'])}*\n 📊 Статус: ${p['Статус']}\n🆔 ID: ${p.Id}\n\n`; });
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }); return;
        }
        if (data === 'create_new_project_from_menu') { bot.answerCallbackQuery(callbackQuery.id); startProjectWizard(chatId); return; }
        if (data === 'add_contact_from_menu') { bot.answerCallbackQuery(callbackQuery.id); startContactWizard(chatId); return; }

        if (data === 'proj_new_for_contact') {
            pendingContactAction.waitingNewProjectName = true;
            bot.answerCallbackQuery(callbackQuery.id);
            bot.sendMessage(chatId, '🚀 *Напиши название нового проекта:*', { parse_mode: 'Markdown' });
            return;
        }
        if (data === 'proj_none_contact') {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Ок' });
            bot.sendMessage(chatId, `✅ Готово! Контакт создан без привязки к проекту.`);
            resetState(); return;
        }

        if (data === 'append_to_project') {
            bot.answerCallbackQuery(callbackQuery.id);
            const contactId = pendingContactAction.contactId;
            const messageText = pendingContactAction.forwardedData.messageText;
            const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
            const newEntry = messageText ? `[${timestamp}] Сообщение от клиента:\n💬 "${messageText}"` : `[${timestamp}] Переслано сообщение (без текста)`;

            const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=50`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const allProjects = res.data.list;
            const linkedProjects = allProjects.filter(p => {
                const contactField = p['Контакт'];
                if (!contactField) return false;
                if (Array.isArray(contactField)) {
                    return contactField.some(c => c.Id === contactId);
                } else if (typeof contactField === 'object') {
                    return contactField.Id === contactId;
                } else if (typeof contactField === 'number' || typeof contactField === 'string') {
                    return contactField == contactId;
                }
                return false;
            });

            if (linkedProjects.length === 1) {
                const proj = linkedProjects[0];
                const oldExtra = String(proj['Подробности'] || '').trim();
                const finalExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
                await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}/${proj.Id}`, { 'Подробности': finalExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                bot.sendMessage(chatId, `✅ Текст добавлен в проект "${escapeMarkdown(proj['Что делаем?'])}"`, { parse_mode: 'Markdown' });
                resetState();
            } else if (linkedProjects.length > 1) {
                let text = `У контакта ${linkedProjects.length} активных проекта. Куда добавить?\n`;
                const inlineKeyboard = linkedProjects.map(p => [{ text: `📂 ${escapeMarkdown(p['Что делаем?'])}`, callback_data: `append_to_proj_${p.Id}` }]);
                inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'cancel_msg_append' }]);
                pendingContactAction.tempMessageEntry = newEntry; 
                await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            } else {
                const activeProjects = allProjects.filter(p => p['Активно'] === 'Активно');
                if (activeProjects.length === 0) {
                    bot.sendMessage(chatId, `❌ Нет активных проектов. Сначала создайте проект.`, { parse_mode: 'Markdown' });
                    resetState();
                } else {
                    let text = `У контакта нет активных проектов. Выберите любой проект для добавления:\n`;
                    const inlineKeyboard = activeProjects.map(p => [{ text: `📂 ${escapeMarkdown(p['Что делаем?'])}`, callback_data: `append_to_proj_${p.Id}` }]);
                    pendingContactAction.tempMessageEntry = newEntry;
                    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
                }
            }
            return;
        }

        if (data.startsWith('append_to_proj_')) {
            const projectId = parseInt(data.split('_')[3]);
            const newEntry = pendingContactAction.tempMessageEntry;
            const currentProj = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const oldExtra = String(currentProj.data['Подробности'] || '').trim();
            const finalExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
            await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Подробности': finalExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Добавлено!' });
            bot.sendMessage(chatId, `✅ Текст добавлен в проект "${escapeMarkdown(currentProj.data['Что делаем?'])}"`, { parse_mode: 'Markdown' });
            resetState();
            return;
        }
        
        if (data === 'append_to_contact') {
            const cId = pendingContactAction.contactId;
            const { contactName, messageText } = pendingContactAction.forwardedData;
            const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
            const current = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${cId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const oldExtra = String(current.data['Доп. информация'] || '').trim();
            const newEntry = messageText ? `[${timestamp}] Пересылка от ${contactName}\n💬 "${messageText}"` : `[${timestamp}] Пересылка от ${contactName}`;
            const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
            await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${cId}`, { 'Доп. информация': newExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Добавлено!' });
            bot.sendMessage(chatId, `✅ Информация добавлена в контакт!`, { parse_mode: 'Markdown' });
            resetState(); return;
        }
        if (data === 'cancel_msg_append') {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
            bot.sendMessage(chatId, '❌ Отменено.');
            resetState(); return;
        }

    } catch (err) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка!' });
        console.error('Callback error:', err.message);
    }
});

// ================== ОБНОВЛЁННЫЙ СПИСОК ЗАДАЧ (с кнопкой ✏️) ==================
async function sendTaskList(chatId, messageId) {
    const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}?limit=50`, { headers: { 'xc-token': config.NOCO_TOKEN } });
    const activeTasks = res.data.list.filter(t => !t['Готово']);
    let text = `📋 *Активные задачи (${activeTasks.length})*\n\n`;
    if (activeTasks.length === 0) text += '🎉 Все задачи выполнены!';
    else activeTasks.forEach(t => { text += `*#${t.Id}* ${escapeMarkdown(t['Что делаем?'])}\n   📅 ${t['Когда делаем'] ? formatMinskDate(t['Когда делаем']) : 'Без срока'}\n\n`; });
    
    // Добавляем кнопки: Закрыть + Изменить для каждой задачи
    const inlineKeyboard = [];
    activeTasks.forEach(t => {
        inlineKeyboard.push([
            { text: `✅ Закрыть #${t.Id}`, callback_data: `done_${t.Id}` },
            { text: `✏️`, callback_data: `edit_${t.Id}` }
        ]);
    });
    inlineKeyboard.push([{ text: '🔄 Обновить', callback_data: 'refresh_tasks' }]);
    
    const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
    try {
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (e) { if (e.response?.body?.error_code !== 400) await bot.sendMessage(chatId, text, options); }
}


// ================== КОМАНДА /status ==================
// ================== КОМАНДА /BACKUP ==================
bot.onText(/\/backup/, async (msg) => {
    const chatId = msg.chat.id;
    let message = `💾 *Статус бэкапов:*\n\n`;
    
    // Локальный бэкап
    try {
        const fs = require('fs').promises;
        const path = require('path');
        const backupDir = '/mnt/data/backups';
        const files = await fs.readdir(backupDir);
        const backupFiles = files.filter(f => f.startsWith('nocodb_full_backup_') && f.endsWith('.tar.gz'));
        
        if (backupFiles.length > 0) {
            backupFiles.sort().reverse();
            const latest = backupFiles[0];
            const stats = await fs.stat(path.join(backupDir, latest));
            const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
            const age = Math.floor((Date.now() - stats.mtimeMs) / (1000 * 60 * 60));
            const ageText = age < 24 ? `${age}ч назад` : `${Math.floor(age / 24)}д ${age % 24}ч назад`;
            message += `✅ *Локальный:* ${sizeMB}MB (${ageText})\n`;
            message += `   📁 Всего: ${backupFiles.length} бэкапов\n`;
        } else {
            message += `❌ *Локальный:* не найден\n`;
        }
    } catch (err) {
        message += `❌ *Локальный:* ошибка (${err.message})\n`;
    }
    
    // Облачный бэкап
    try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        
        const { stdout } = await execAsync('rclone --config ~/.config/rclone/rclone.conf lsl grive:nocodb-backups 2>&1');
        const lines = stdout.trim().split('\n').filter(l => l.includes('nocodb_full_backup_'));
        
        if (lines.length > 0) {
            const latest = lines[lines.length - 1];
            const parts = latest.trim().split(/\s+/);
            const sizeBytes = parseInt(parts[0]);
            const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
            const dateStr = parts[1] + ' ' + parts[2].substring(0, 5);
            message += `✅ *Облако:* ${sizeMB}MB (${dateStr})\n`;
            message += `   📁 Всего: ${lines.length} бэкапов\n`;
        } else {
            message += `❌ *Облако:* не найден\n`;
        }
    } catch (err) {
        message += `❌ *Облако:* ошибка (${err.message})\n`;
    }
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    let message = '📊 *СОСТОЯНИЕ СИСТЕМЫ*\n\n';
    
    // 1. Проверяем NocoDB
    try {
        const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=1`, {
            headers: { 'xc-token': config.NOCO_TOKEN },
            timeout: 3000
        });
        message += '🟢 *NocoDB:* online\n';
    } catch (err) {
        message += '🔴 *NocoDB:* offline ❌\n';
    }
    
    // 2. Проверяем pdf-generator (сам себя через host.docker.internal)
    try {
        const res = await axios.get('http://host.docker.internal:3000/api/my-details', { timeout: 3000 });
        message += '🟢 *pdf-generator:* online\n';
    } catch (err) {
        message += '🔴 *pdf-generator:* offline ❌\n';
    }
    
    // 3. Проверяем project-webhook через host.docker.internal
    try {
        const res = await axios.get('http://host.docker.internal:3001/', { timeout: 3000 });
        message += '🟢 *project-webhook:* online\n';
    } catch (err) {
        // Если корневая не отвечает, пробуем create-folder
        try {
            await axios.get('http://host.docker.internal:3001/health', { timeout: 3000 });
            message += '🟢 *project-webhook:* online\n';
        } catch (err2) {
            message += '🔴 *project-webhook:* offline ❌\n';
        }
    }
    
    // 4. Проверяем Nginx через HTTPS запрос
    try {
        const res = await axios.get(process.env.NOCO_DOMAIN || 'http://localhost:8081', { timeout: 3000, validateStatus: () => true });
        message += '🟢 *Nginx:* active\n';
    } catch (err) {
        message += '🔴 *Nginx:* inactive ❌\n';
    }
    
    message += '\n💾 *Диск:*\n';
    try {
        const { execSync } = require('child_process');
        const dfOutput = execSync("df -h /mnt/data | tail -1").toString().trim();
        const parts = dfOutput.split(/\s+/);
        const df = `${parts[2]}/${parts[1]} (${parts[4]} занято)`;
        message += `   ${df}\n`;
    } catch (err) {
        message += '   ⚠️ Не удалось получить\n';
    }
    
    message += '\n🧠 *RAM:*\n';
    try {
        const { execSync } = require('child_process');
        const memOutput = execSync("free -h | grep Mem").toString().trim();
        const parts = memOutput.split(/\s+/);
        const mem = `${parts[2]}/${parts[1]}`;
        message += `   ${mem}\n`;
    } catch (err) {
        message += '   ⚠️ Не удалось получить\n';
    }
    
    // 5. Статистика из NocoDB
    try {
        const docsRes = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.DOCUMENTS}?limit=1000`, {
            headers: { 'xc-token': config.NOCO_TOKEN },
            timeout: 3000
        });
        const docsCount = docsRes.data.list.length;
        
        const projRes = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=1000`, {
            headers: { 'xc-token': config.NOCO_TOKEN },
            timeout: 3000
        });
        const projCount = projRes.data.list.length;
        
        message += `\n📈 *Статистика:*\n`;
        message += `   • Документов: ${docsCount}\n`;
        message += `   • Проектов: ${projCount}\n`;
    } catch (err) {
        message += '\n⚠️ Не удалось получить статистику\n';
    }
    
    message += `\n⏰ *Время:* ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })}`;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/start/, async (msg) => {
    resetState();
    const chatId = msg.chat.id;
    try {
        const [tasksRes, projectsRes, contactsRes] = await Promise.all([
            axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}?limit=50`, { headers: { 'xc-token': config.NOCO_TOKEN } }),
            axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=50`, { headers: { 'xc-token': config.NOCO_TOKEN } }),
            axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=50`, { headers: { 'xc-token': config.NOCO_TOKEN } })
        ]);
        const activeTasks = tasksRes.data.list.filter(t => !t['Готово']);
        const activeProjects = projectsRes.data.list.filter(p => p['Активно'] === 'Активно');
        const contactsCount = contactsRes.data.list.length;

        let nearestTaskText = "Нет активных задач 🎉";
        if (activeTasks.length > 0) {
            const sortedTasks = activeTasks.sort((a, b) => {
                const dateA = a['Когда делаем'] ? new Date(a['Когда делаем']).getTime() : Infinity;
                const dateB = b['Когда делаем'] ? new Date(b['Когда делаем']).getTime() : Infinity;
                return dateA - dateB;
            });
            const nearest = sortedTasks[0];
            nearestTaskText = `🔹 *#${nearest.Id}* ${nearest['Что делаем?']} — ${nearest['Когда делаем'] ? formatMinskDate(nearest['Когда делаем']) : 'Без срока'}`;
        }

        let message = `👋 *Привет!* Добро пожаловать в вашу CRM.\n\n`;
        message += `📊 *ТВОЯ СВОДКА:*\n`;
        message += `📋 Активных задач: *${activeTasks.length}*\n`;
        message += `🚀 Активных проектов: *${activeProjects.length}*\n`;
        message += `👤 Контактов в базе: *${contactsCount}*\n\n`;
        message += `⏰ *Ближайший дедлайн:*\n${nearestTaskText}\n\n`;
        message += `💡 *Лайфхак:* Просто перешли мне сообщение от клиента!`;

        const inlineKeyboard = [
            [{ text: '📋 Мои задачи', callback_data: 'refresh_tasks' }, { text: '📅 Сегодня', callback_data: 'show_today' }],
            [{ text: '📝 Новая задача', callback_data: 'start_new_task' }, { text: '📜 История', callback_data: 'show_history' }],
            [{ text: '🚀 Проекты', callback_data: 'show_projects' }, { text: '👥 Контакты', callback_data: 'show_contacts' }],
            [{ text: '➕ Создать проект', callback_data: 'create_new_project_from_menu' }, { text: '👤 Добавить контакт', callback_data: 'add_contact_from_menu' }]
        ];
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
        console.error('Ошибка сводки:', err.message);
        await bot.sendMessage(chatId, `❌ Ошибка подключения к базе: ${err.message}`);
    }
});

bot.onText(/\/new$/, (msg) => { resetState(); currentState = STATE.WAITING_TITLE; bot.sendMessage(msg.chat.id, '📝 *Что нужно сделать?*', { parse_mode: 'Markdown' }); });
bot.onText(/\/cancel/, (msg) => { resetState(); bot.sendMessage(msg.chat.id, '❌ Отменено.'); });
bot.onText(/\/tasks/, async (msg) => { resetState(); await sendTaskList(msg.chat.id, null); });

// ================== НОВОЕ: КОМАНДА /today ==================
bot.onText(/\/today/, async (msg) => { 
    resetState(); 
    await sendTodayTasks(msg.chat.id); 
});

// ================== НОВОЕ: КОМАНДА /history ==================
bot.onText(/\/history/, async (msg) => { 
    resetState(); 
    await sendTaskHistory(msg.chat.id); 
});

bot.onText(/^\/add_contact$/, (msg) => { resetState(); startContactWizard(msg.chat.id); });
bot.onText(/^\/add_contact (.+)/, async (msg, match) => {
    resetState();
    const input = match[1];
    const phoneMatch = input.match(/(\+?\d[\d\s\-\(\)]{7,}\d)/);
    const usernameMatch = input.match(/@([a-zA-Z0-9_]{3,})/);
    let name = input, phone = '', username = '', messenger = 'Telegram';
    if (phoneMatch) { phone = phoneMatch[1].trim(); name = input.replace(phone, '').trim(); }
    if (usernameMatch) { username = usernameMatch[1]; name = name.replace(`@${username}`, '').trim(); }
    if (!name) return bot.sendMessage(msg.chat.id, '❌ Пример: `/add_contact Иван +375291234567 @vasiok`', { parse_mode: 'Markdown' });
    
    const duplicate = await findDuplicateContact(null, phone, username);
    if (duplicate) {
        return bot.sendMessage(msg.chat.id, `⚠️ Контакт уже есть: *${escapeMarkdown(duplicate['Имя'])}* (${duplicate['Телефон'] || 'нет тел.'}).\nID: ${duplicate.Id}`, { parse_mode: 'Markdown' });
    }

    try {
        const payload = { 'Имя': name, 'Мессенджер': messenger };
        if (phone) payload['Телефон'] = phone;
        if (username) payload['Ссылка'] = `https://t.me/${username}`;
        const res = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
        bot.sendMessage(msg.chat.id, `✅ *Контакт создан!*\n👤 ${name}\n📱 ${phone || 'нет'}\n🔗 ${username ? `https://t.me/${username}` : 'нет'}\n🆔 ID: ${res.data.Id}`, { parse_mode: 'Markdown' });
        showProjectSelectionForContact(msg.chat.id, res.data.Id);
    } catch (err) { bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`); }
});

bot.onText(/^\/project$/, (msg) => { resetState(); startProjectWizard(msg.chat.id); });
bot.onText(/^\/project (.+)/, async (msg, match) => {
    resetState();
    try {
        const res = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}`, { 'Что делаем?': match[1], 'Статус': 'Обсуждение' }, { headers: { 'xc-token': config.NOCO_TOKEN } });
        bot.sendMessage(msg.chat.id, `🚀 *Проект создан!*\n📝 ${match[1]}\n🆔 ID: ${res.data.Id}`, { parse_mode: 'Markdown' });
    } catch (err) { bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`); }
});

bot.onText(/\/contacts/, async (msg) => {
    resetState();
    try {
        const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=20`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        let message = `📇 *Контакты (${res.data.list.length})*\n\n`;
        if (res.data.list.length === 0) message += '📭 Пусто.';
        else res.data.list.forEach(c => { 
            const link = c['Ссылка'] ? `\n 🔗 ${c['Ссылка']}` : '';
            message += `👤 *${escapeMarkdown(c['Имя'])}*\n 📱 ${c['Телефон'] || 'нет'}${link}\n\n`; 
        });
        bot.sendMessage(msg.chat.id, message);
    } catch (err) { bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`); }
});

async function handleForwardedMessage(msg) {
    const user = msg.forward_from;
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const username = user.username ? `@${user.username}` : '';
    const tgId = user.id;
    const contactName = name;
    const messageText = msg.text || msg.caption || '';
    const shortText = messageText.length > 200 ? messageText.substring(0, 200) + '...' : messageText;

    try {
        const existingContact = await findDuplicateContact(tgId, null, user.username);

        // Сохраняем данные для всех действий
        pendingContactAction = {
            active: true,
            contactId: existingContact ? existingContact.Id : null,
            waitingPhone: false,
            waitingNewProjectName: false,
            waitingProjectForMessage: false,
            isNew: !existingContact,
            forwardedData: { contactName, messageText: shortText, projectId: null, tgId, username: user.username },
            tgId: tgId
        };

        let text;
        if (existingContact) {
            text = `⚠️ *Контакт уже есть в базе!*\n\n👤 *${existingContact['Имя']}*`;
        } else {
            text = `🆕 *Новый контакт!*\n\n👤 *${escapeMarkdown(contactName)}*`;
            if (user.username) text += `\n🔗 ${user.username}`;
        }
        if (shortText) text += `\n\n📄 *Текст:* ${escapeMarkdown(shortText)}`;
        text += `\n\n*Что делаем?*`;

        const inlineKeyboard = [
            [{ text: '➕ Создать новый контакт', callback_data: 'forward_create_new' }],
            [{ text: '📝 Добавить к существующему контакту', callback_data: 'forward_add_to_contact' }],
            [{ text: '📂 Добавить к проекту', callback_data: 'forward_add_to_project' }]
        ];

        await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) { bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`); }
}

bot.on('message', async (msg) => {
    // Пересланные сообщения обрабатываем всегда
    if (msg.forward_date || msg.forward_from || msg.forward_from_chat) {
        // Продолжаем обработку ниже
    } else if (currentState !== STATE.IDLE) {
        // Обычные текстовые сообщения игнорируем в других состояниях
        return;
    }
    
    if (!msg.text && !msg.forward_date) return;
    
    if (msg.forward_date && !msg.forward_from && !msg.forward_from_chat) {
        const messageText = msg.text || msg.caption || '';
        const shortText = messageText.length > 200 ? messageText.substring(0, 200) + '...' : messageText;

        pendingContactAction = {
            active: true, contactId: null, waitingPhone: false,
            waitingNewProjectName: false, waitingProjectForMessage: false,
            forwardedData: { messageText: shortText, projectId: null },
            isHiddenProfile: true,
            hiddenProfileMessageText: shortText
        };
        
        // Сразу показываем меню действий
        const inlineKeyboard = [
            [{ text: '➕ Создать новый контакт', callback_data: 'hidden_create_new' }],
            [{ text: '📝 Добавить к существующему контакту', callback_data: 'hidden_add_to_contact' }],
            [{ text: '📂 Добавить к проекту', callback_data: 'hidden_add_to_project' }]
        ];
        
        bot.sendMessage(msg.chat.id, `🕵️ *Профиль отправителя скрыт.*\n\nTelegram не показывает мне имя и ID этого человека из-за его настроек приватности.\n\n📄 *Текст пересланного сообщения:*\n_${escapeMarkdown(shortText) || '(без текста)'}_\n\n*Что делаем?*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        return;
    }

    if (msg.forward_from_chat) {
        try {
            const res = await axios.post(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}`, { 'Имя': `${msg.forward_from_chat.title || 'Канал'}`, 'Мессенджер': 'Telegram' }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(msg.chat.id, `✅ *Контакт канала создан!*`, { parse_mode: 'Markdown' });
            showProjectSelectionForContact(msg.chat.id, res.data.Id);
        } catch (err) { bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`); }
        return;
    }
    if (msg.forward_from) { 
        console.log(`📨 Получено пересланное сообщение от ${msg.forward_from.first_name}`);
        await handleForwardedMessage(msg); 
    }
});


// ================== ОБРАБОТЧИКИ ДЛЯ СКРЫТОГО ПРОФИЛЯ ==================
bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    
    if (data === 'hidden_create_new') {
        bot.answerCallbackQuery(callbackQuery.id);
        currentState = STATE.WAITING_CONTACT_NAME;
        bot.sendMessage(chatId, `✏️ *Напиши ИМЯ этого человека:*`, { parse_mode: 'Markdown' });
        return;
    }
    
    if (data === 'hidden_add_to_contact') {
        bot.answerCallbackQuery(callbackQuery.id);
        // Показываем ТОЛЬКО контакты из активных проектов
        try {
            // Получаем все проекты
            const projectsRes = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=100`, {
                headers: { 'xc-token': config.NOCO_TOKEN }
            });
            
            // Фильтруем активные и извлекаем уникальные ID контактов
            const activeProjects = projectsRes.data.list.filter(p => p['Активно'] === 'Активно' && p['Контакт']);
            const contactIds = [...new Set(activeProjects.map(p => p['Контакт'].Id))];
            
            console.log(`🔍 Активных проектов с контактами: ${activeProjects.length}, уникальных контактов: ${contactIds.length}`);
            
            if (contactIds.length === 0) {
                await bot.sendMessage(chatId, `📭 Нет контактов в активных проектах.`, { parse_mode: 'Markdown' });
                return;
            }
            
            // Получаем только эти контакты
            const contactsRes = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=100`, {
                headers: { 'xc-token': config.NOCO_TOKEN }
            });
            const relevantContacts = contactsRes.data.list.filter(c => contactIds.includes(c.Id));
            
            let message = `👥 *Контакты из активных проектов (${relevantContacts.length}):*

`;
            const inlineKeyboard = [];
            relevantContacts.forEach(c => {
                const phone = c['Телефон'] ? ` (${escapeMarkdown(c['Телефон'])})` : '';
                inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `hidden_select_contact_${c.Id}` }]);
            });
            inlineKeyboard.push([{ text: '📋 Показать все контакты', callback_data: 'hidden_show_all_contacts' }]);
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'hidden_cancel' }]);
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }
    
    if (data === 'hidden_show_all_contacts') {
        bot.answerCallbackQuery(callbackQuery.id);
        // Показываем ВСЕ контакты
        try {
            const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=50&sort=-Id`, {
                headers: { 'xc-token': config.NOCO_TOKEN }
            });
            let message = `👥 *Все контакты (${res.data.list.length}):*\n\n`;
            const inlineKeyboard = [];
            res.data.list.forEach(c => {
                const phone = c['Телефон'] ? ` (${escapeMarkdown(c['Телефон'])})` : '';
                inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `hidden_select_contact_${c.Id}` }]);
            });
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'hidden_cancel' }]);
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data.startsWith('hidden_select_contact_')) {
        bot.answerCallbackQuery(callbackQuery.id);
        const contactId = parseInt(data.split('_')[3]);
        pendingContactAction.contactId = contactId;
        
        // Добавляем текст в доп. инфо
        try {
            const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
            const newEntry = `[${timestamp}] Пересылка (скрытый профиль)\n💬 "${pendingContactAction.hiddenProfileMessageText}"`;
            const current = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const oldExtra = String(current.data['Доп. информация'] || '').trim();
            const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
            await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { 'Доп. информация': newExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `✅ Текст добавлен в карточку контакта!`);
            
            // Сбрасываем состояние
            pendingContactAction.isHiddenProfile = false;
            pendingContactAction.hiddenProfileMessageText = '';
            pendingContactAction.active = false;
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }
    
    if (data === 'hidden_add_to_project') {
        bot.answerCallbackQuery(callbackQuery.id);
        // Показываем список АКТИВНЫХ проектов для выбора
        try {
            const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=50&sort=-Id`, { 
                headers: { 'xc-token': config.NOCO_TOKEN } 
            });
            const activeProjects = res.data.list.filter(p => p['Активно'] === 'Активно');
            
            let message = `📂 *Выбери АКТИВНЫЙ проект для добавления текста:*\n\n`;
            if (activeProjects.length === 0) {
                message += '📭 Нет активных проектов.';
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                return;
            }
            
            const inlineKeyboard = [];
            activeProjects.forEach(p => {
                inlineKeyboard.push([{ text: `📝 ${escapeMarkdown(p['Что делаем?'])} (ID:${p.Id})`, callback_data: `hidden_select_project_${p.Id}` }]);
            });
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'hidden_cancel' }]);
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }
    
    if (data.startsWith('hidden_select_project_')) {
        bot.answerCallbackQuery(callbackQuery.id);
        const projectId = parseInt(data.split('_')[3]);
        
        // Добавляем текст в подробности проекта
        try {
            const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
            const newEntry = `[${timestamp}] Пересылка (скрытый профиль)\n💬 "${pendingContactAction.hiddenProfileMessageText}"`;
            const current = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const oldExtra = String(current.data['Подробности'] || '').trim();
            const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
            await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Подробности': newExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `✅ Текст добавлен в проект!`);
            
            // Сбрасываем состояние
            pendingContactAction.isHiddenProfile = false;
            pendingContactAction.hiddenProfileMessageText = '';
            pendingContactAction.active = false;
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }
    
    if (data === 'hidden_cancel') {
        bot.answerCallbackQuery(callbackQuery.id);
        pendingContactAction.isHiddenProfile = false;
        pendingContactAction.hiddenProfileMessageText = '';
        pendingContactAction.active = false;
        bot.sendMessage(chatId, `❌ Отменено.`);
        return;
    }

    // ================== ОБРАБОТЧИКИ ДЛЯ ОТКРЫТЫХ ПРОФИЛЕЙ (forward_*) ==================
    if (data === 'forward_create_new') {
        bot.answerCallbackQuery(callbackQuery.id);
        
        // Если контакт уже существует — всё равно создаём нового
        if (pendingContactAction.contactId && !pendingContactAction.isNew) {
            // Контакт есть в базе, но пользователь хочет создать нового
            pendingContactAction.contactId = null;
            pendingContactAction.isNew = true;
        }
        
        currentState = STATE.WAITING_CONTACT_NAME;
        // Если есть известное имя из открытого профиля — показываем его
        const knownName = pendingContactAction.forwardedData?.contactName;
        if (knownName) {
            bot.sendMessage(chatId, `✏️ *Имя:* ${escapeMarkdown(knownName)}\n\n📄 Текст сообщения будет сохранён после создания контакта.\n\n💡 *Напиши новое имя* или /skip чтобы использовать указанное.`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, `✏️ *Напиши ИМЯ этого человека:*\n\n📄 Текст сообщения будет сохранён после создания контакта.`, { parse_mode: 'Markdown' });
        }
        return;
    }

    if (data === 'forward_add_to_contact') {
        bot.answerCallbackQuery(callbackQuery.id);
        
        // Если контакт уже найден (по TG ID или username) — сразу добавляем текст
        if (pendingContactAction.contactId) {
            const contactId = pendingContactAction.contactId;
            const messageText = pendingContactAction.forwardedData.messageText;
            const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });

            try {
                const current = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, {
                    headers: { 'xc-token': config.NOCO_TOKEN }
                });
                const oldExtra = String(current.data['Доп. информация'] || '').trim();
                const newEntry = messageText ? `[${timestamp}] Пересылка\n💬 "${escapeMarkdown(messageText)}"` : `[${timestamp}] Переслано сообщение (без текста)`;
                const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;

                await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, {
                    'Доп. информация': newExtra
                }, { headers: { 'xc-token': config.NOCO_TOKEN } });

                bot.sendMessage(chatId, `✅ Текст добавлен в контакт *${escapeMarkdown(current.data['Имя'])}*\n\n📄 ${escapeMarkdown(messageText || '(без текста)')}`, { parse_mode: 'Markdown' });
                pendingContactAction.active = false;
            } catch (err) {
                bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
            }
            return;
        }

        // Показываем список контактов из активных проектов
        try {
            const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=100&sort=-Id`, {
                headers: { 'xc-token': config.NOCO_TOKEN }
            });
            const allContacts = res.data.list;
            
            // Получаем контакты из активных проектов
            const projRes = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=100`, {
                headers: { 'xc-token': config.NOCO_TOKEN }
            });
            const activeProjects = projRes.data.list.filter(p => p['Активно'] === 'Активно');
            const activeContactIds = new Set();
            activeProjects.forEach(p => {
                const c = p['Контакт'];
                if (c) {
                    const id = Array.isArray(c) ? c[0]?.Id : c.Id;
                    if (id) activeContactIds.add(id);
                }
            });
            
            const activeContacts = allContacts.filter(c => activeContactIds.has(c.Id));
            
            let message = `👤 *Выбери контакт для добавления текста:*\n\n`;
            if (activeContacts.length === 0) {
                message += '📭 Нет контактов в активных проектах.';
            } else {
                message += `📋 Контакты из активных проектов (${activeContacts.length}):\n\n`;
            }
            
            const inlineKeyboard = [];
            activeContacts.slice(0, 10).forEach(c => {
                const phone = c['Телефон'] ? ` 📱${escapeMarkdown(c['Телефон'])}` : '';
                inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `forward_select_contact_${c.Id}` }]);
            });
            
            if (allContacts.length > activeContacts.length) {
                inlineKeyboard.push([{ text: '📋 Показать все контакты', callback_data: 'forward_show_all_contacts' }]);
            }
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'forward_cancel' }]);
            
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data === 'forward_show_all_contacts') {
        bot.answerCallbackQuery(callbackQuery.id);
        try {
            const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=100&sort=-Id`, {
                headers: { 'xc-token': config.NOCO_TOKEN }
            });
            const contacts = res.data.list;
            
            const inlineKeyboard = [];
            contacts.slice(0, 20).forEach(c => {
                const phone = c['Телефон'] ? ` 📱${escapeMarkdown(c['Телефон'])}` : '';
                inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `forward_select_contact_${c.Id}` }]);
            });
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'forward_cancel' }]);
            
            await bot.sendMessage(chatId, `👤 *Все контакты (${contacts.length}):*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data.startsWith('forward_select_contact_')) {
        bot.answerCallbackQuery(callbackQuery.id);
        const contactId = parseInt(data.split('_')[3]);
        const messageText = pendingContactAction.forwardedData.messageText;
        const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
        
        try {
            const current = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, {
                headers: { 'xc-token': config.NOCO_TOKEN }
            });
            const oldExtra = String(current.data['Доп. информация'] || '').trim();
            const newEntry = messageText ? `[${timestamp}] Пересылка\n💬 "${escapeMarkdown(messageText)}"` : `[${timestamp}] Переслано сообщение (без текста)`;
            const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
            
            await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, {
                'Доп. информация': newExtra
            }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            
            bot.sendMessage(chatId, `✅ Текст добавлен в контакт *${escapeMarkdown(current.data['Имя'])}*`, { parse_mode: 'Markdown' });
            pendingContactAction.active = false;
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data === 'forward_add_to_project') {
        bot.answerCallbackQuery(callbackQuery.id);
        try {
            const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=50&sort=-Id`, {
                headers: { 'xc-token': config.NOCO_TOKEN }
            });
            const activeProjects = res.data.list.filter(p => p['Активно'] === 'Активно');
            
            let message = `📂 *Выбери АКТИВНЫЙ проект для добавления текста:*\n\n`;
            if (activeProjects.length === 0) {
                message += '📭 Нет активных проектов.';
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                return;
            }
            
            const inlineKeyboard = [];
            activeProjects.forEach(p => {
                inlineKeyboard.push([{ text: `📝 ${escapeMarkdown(p['Что делаем?'])} (ID:${p.Id})`, callback_data: `forward_select_project_${p.Id}` }]);
            });
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'forward_cancel' }]);
            
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data.startsWith('forward_select_project_')) {
        bot.answerCallbackQuery(callbackQuery.id);
        const projectId = parseInt(data.split('_')[3]);
        const messageText = pendingContactAction.forwardedData.messageText;
        const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
        
        try {
            const current = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, {
                headers: { 'xc-token': config.NOCO_TOKEN }
            });
            const oldDetails = String(current.data['Подробности'] || '').trim();
            const newEntry = messageText ? `[${timestamp}] Пересылка\n💬 "${escapeMarkdown(messageText)}"` : `[${timestamp}] Переслано сообщение (без текста)`;
            const newDetails = oldDetails ? `${oldDetails}\n\n${newEntry}` : newEntry;
            
            await axios.patch(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, {
                'Подробности': newDetails
            }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            
            bot.sendMessage(chatId, `✅ Текст добавлен в проект *${escapeMarkdown(current.data['Что делаем?'])}*`, { parse_mode: 'Markdown' });
            pendingContactAction.active = false;
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data === 'forward_cancel') {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
        bot.sendMessage(chatId, '❌ Отменено.');
        pendingContactAction.active = false;
        return;
    }
});

// ================== УТРЕННЯЯ РАССЫЛКА ==================
cron.schedule(config.CRON_TIME, async () => {
    console.log('⏰ Утренняя рассылка...');
    try {
        const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}?limit=50`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const tasks = res.data.list.filter(t => !t['Готово']);
        let message = `🌅 *Доброе утро!* (${new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Minsk' })})\n\n`;
        if (tasks.length === 0) message += '✅ Нет активных задач.\n\n';
        else {
            message += `📌 *Активных: ${tasks.length}*\n\n`;
            tasks.forEach(t => { message += `🔹 *#${t.Id}* ${escapeMarkdown(t['Что делаем?'])}\n   📅 ${t['Когда делаем'] ? formatMinskDate(t['Когда делаем']) : 'Без срока'}\n\n`; });
        }
        
        // Проверяем бэкапы
        message += `💾 *Бэкапы:*\n`;
        
        // Локальный бэкап
        try {
            const fs = require('fs').promises;
            const path = require('path');
            const backupDir = '/mnt/data/backups';
            const files = await fs.readdir(backupDir);
            const backupFiles = files.filter(f => f.startsWith('nocodb_full_backup_') && f.endsWith('.tar.gz'));
            
            if (backupFiles.length > 0) {
                // Сортируем по имени (дата в имени)
                backupFiles.sort().reverse();
                const latest = backupFiles[0];
                const stats = await fs.stat(path.join(backupDir, latest));
                const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
                const age = Math.floor((Date.now() - stats.mtimeMs) / (1000 * 60 * 60));
                message += `✅ Локальный: ${sizeMB}MB (${age}ч назад)\n`;
            } else {
                message += `❌ Локальный: не найден\n`;
            }
        } catch (err) {
            message += `❌ Локальный: ошибка (${err.message})\n`;
        }
        
        // Облачный бэкап
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            const { stdout } = await execAsync('rclone --config ~/.config/rclone/rclone.conf lsl grive:nocodb-backups 2>&1');
            const lines = stdout.trim().split('\n').filter(l => l.includes('nocodb_full_backup_'));
            
            if (lines.length > 0) {
                // Берём последнюю строку (самый свежий)
                const latest = lines[lines.length - 1];
                const parts = latest.trim().split(/\s+/);
                const sizeBytes = parseInt(parts[0]);
                const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
                const dateStr = parts[1] + ' ' + parts[2];
                message += `✅ Облако: ${sizeMB}MB (${dateStr})\n`;
            } else {
                message += `❌ Облако: не найден\n`;
            }
        } catch (err) {
            message += `❌ Облако: ошибка (${err.message})\n`;
        }
        
        bot.sendMessage(config.MY_ID, message, { parse_mode: 'Markdown' });
    } catch (err) { console.error('❌ Ошибка рассылки:', err.message); }
});

// ================== НОВОЕ: НАПОМИНАНИЯ О ДЕДЛАЙНАХ ==================
// Запускаем каждые 30 минут
cron.schedule('*/30 * * * *', async () => {
    try {
        const res = await axios.get(`${config.NOCO_URL}/sql/${config.BASE_ID}/${config.TABLES.TASKS}?limit=50`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const activeTasks = res.data.list.filter(t => !t['Готово'] && t['Когда делаем']);
        
        const now = new Date();
        
        for (const task of activeTasks) {
            const deadline = new Date(task['Когда делаем']);
            const diffMs = deadline - now;
            const diffHours = diffMs / (1000 * 60 * 60);
            const diffDays = diffMs / (1000 * 60 * 60 * 24);
            
            // Напоминание за 24 часа (±1 час)
            if (diffHours > 23 && diffHours < 25) {
                bot.sendMessage(config.MY_ID, 
                    `⏰ *Напоминание: завтра дедлайн!*\n\n🔹 *#${task.Id}* ${escapeMarkdown(task['Что делаем?'])}\n📅 ${formatMinskDate(task['Когда делаем'])}`, 
                    { parse_mode: 'Markdown' });
            }
            
            // Напоминание за 2 часа (±15 мин)
            if (diffHours > 1.75 && diffHours < 2.25) {
                bot.sendMessage(config.MY_ID, 
                    `🔥 *СРОЧНО: через 2 часа дедлайн!*\n\n🔹 *#${task.Id}* ${escapeMarkdown(task['Что делаем?'])}\n📅 ${formatMinskDate(task['Когда делаем'])}`, 
                    { parse_mode: 'Markdown' });
            }
        }
    } catch (err) { 
        console.error('❌ Ошибка напоминаний:', err.message); 
    }
});

console.log('🤖 Бот запущен и готов к работе! 🚀');
