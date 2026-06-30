const axios = require('axios');
const fs = require('fs');

const NOCO_URL = process.env.NOCO_URL || 'http://nocodb:8080';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@printed4u.by';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Printed4U2026!';

const API = axios.create({ baseURL: NOCO_URL + '/api/v1' });

// Временный токен для инициализации
let token = '';

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForNocoDB() {
  console.log('⏳ Ожидание запуска NocoDB...');
  for (let i = 0; i < 30; i++) {
    try {
      await axios.get(NOCO_URL + '/api/v1/db/meta');
      console.log('✅ NocoDB готов!');
      return;
    } catch {
      await wait(2000);
    }
  }
  throw new Error('NocoDB не запустился за 60 секунд');
}

async function createAdmin() {
  console.log('👤 Создание администратора...');
  try {
    await API.post('/auth/user/signup', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD
    });
  } catch (e) {
    if (!e.response?.data?.msg?.includes('already exists')) throw e;
    console.log('   Админ уже существует');
  }
}

async function login() {
  console.log('🔑 Авторизация...');
  const res = await API.post('/auth/user/signin', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD
  });
  token = res.data.token;
  API.defaults.headers['xc-token'] = token;
}

async function createProject() {
  console.log('📁 Создание проекта "CRM"...');
  try {
    const res = await API.post('/db/meta/projects', { title: 'CRM', type: 'sqlite' });
    return res.data.id;
  } catch (e) {
    if (e.response?.status === 400) {
      const projects = await API.get('/db/meta/projects');
      return projects.data.list.find(p => p.title === 'CRM')?.id;
    }
    throw e;
  }
}

const SCHEMA = [
  {
    title: 'Задачи',
    columns: [
      { title: 'Название', uidt: 'SingleLineText' },
      { title: 'Описание', uidt: 'LongText' },
      { title: 'Статус', uidt: 'SingleSelect', dtxp: "['Новая','В работе','Готово','Отменено']" },
      { title: 'Приоритет', uidt: 'SingleSelect', dtxp: "['Низкий','Средний','Высокий','Срочный']" },
      { title: 'Дедлайн', uidt: 'DateTime' },
      { title: 'Проект', uidt: 'SingleLineText' },
      { title: 'Контакт', uidt: 'SingleLineText' }
    ]
  },
  {
    title: 'Контакты',
    columns: [
      { title: 'Имя', uidt: 'SingleLineText' },
      { title: 'Телефон', uidt: 'PhoneNumber' },
      { title: 'Email', uidt: 'Email' },
      { title: 'Telegram', uidt: 'SingleLineText' },
      { title: 'Компания', uidt: 'SingleLineText' },
      { title: 'Тип', uidt: 'SingleSelect', dtxp: "['Клиент','Партнёр','Поставщик']" },
      { title: 'ClientID', uidt: 'SingleLineText' }
    ]
  },
  {
    title: 'Проекты',
    columns: [
      { title: 'Название', uidt: 'SingleLineText' },
      { title: 'Контакт', uidt: 'SingleLineText' },
      { title: 'Статус', uidt: 'SingleSelect', dtxp: "['Новый','В работе','Завершён','Приостановлен']" },
      { title: 'Дата начала', uidt: 'DateTime' },
      { title: 'Дата окончания', uidt: 'DateTime' },
      { title: 'Описание', uidt: 'LongText' },
      { title: 'Папка проекта', uidt: 'SingleLineText' }
    ]
  },
  {
    title: 'Документы',
    columns: [
      { title: 'Название', uidt: 'SingleLineText' },
      { title: 'Тип', uidt: 'SingleSelect', dtxp: "['Счёт','Акт','Накладная','Договор']" },
      { title: 'Проект', uidt: 'SingleLineText' },
      { title: 'Контакт', uidt: 'SingleLineText' },
      { title: 'Сумма', uidt: 'Number' },
      { title: 'Статус', uidt: 'SingleSelect', dtxp: "['Черновик','Отправлен','Оплачен','Подписан']" },
      { title: 'Дата', uidt: 'DateTime' },
      { title: 'PDF путь', uidt: 'SingleLineText' }
    ]
  },
  {
    title: 'Позиции',
    columns: [
      { title: 'Название', uidt: 'SingleLineText' },
      { title: 'Документ', uidt: 'SingleLineText' },
      { title: 'Количество', uidt: 'Number' },
      { title: 'Цена', uidt: 'Number' },
      { title: 'Сумма', uidt: 'Number' },
      { title: 'Описание', uidt: 'LongText' }
    ]
  },
  {
    title: 'Юрлица',
    columns: [
      { title: 'Название', uidt: 'SingleLineText' },
      { title: 'ИНН', uidt: 'SingleLineText' },
      { title: 'КПП', uidt: 'SingleLineText' },
      { title: 'ОГРН', uidt: 'SingleLineText' },
      { title: 'Адрес', uidt: 'LongText' },
      { title: 'Банк', uidt: 'SingleLineText' },
      { title: 'Расчётный счёт', uidt: 'SingleLineText' },
      { title: 'Корр счёт', uidt: 'SingleLineText' },
      { title: 'БИК', uidt: 'SingleLineText' }
    ]
  },
  {
    title: 'Мои реквизиты',
    columns: [
      { title: 'Название', uidt: 'SingleLineText' },
      { title: 'Юрлицо', uidt: 'SingleLineText' },
      { title: 'Директор', uidt: 'SingleLineText' },
      { title: 'Телефон', uidt: 'PhoneNumber' },
      { title: 'Email', uidt: 'Email' },
      { title: 'Сайт', uidt: 'URL' }
    ]
  }
];

async function createTables(projectId) {
  console.log('📋 Создание таблиц...');
  const ids = {};
  
  for (const t of SCHEMA) {
    try {
      const res = await API.post(`/db/meta/projects/${projectId}/tables`, {
        title: t.title,
        columns: t.columns
      });
      ids[t.title] = res.data.id;
      console.log(`   ✅ ${t.title} (ID: ${res.data.id})`);
    } catch (e) {
      if (e.response?.status === 400) {
        console.log(`   ⚠️  ${t.title} уже существует`);
        const tables = await API.get(`/db/meta/projects/${projectId}/tables`);
        const existing = tables.data.list.find(x => x.title === t.title);
        ids[t.title] = existing?.id;
      } else {
        console.error(`    Ошибка создания ${t.title}:`, e.response?.data || e.message);
      }
    }
  }
  return ids;
}

async function saveEnv(projectId, tableIds) {
  const envPath = '/app/.env.generated';
  const content = `
# === AUTO-GENERATED BY INIT CONTAINER ===
NOCO_TOKEN=${token}
BASE_ID=${projectId}
TABLE_TASKS=${tableIds['Задачи'] || ''}
TABLE_CONTACTS=${tableIds['Контакты'] || ''}
TABLE_PROJECTS=${tableIds['Проекты'] || ''}
TABLE_DOCUMENTS=${tableIds['Документы'] || ''}
TABLE_ITEMS=${tableIds['Позиции'] || ''}
TABLE_LEGAL_ENTITIES=${tableIds['Юрлица'] || ''}
TABLE_MY_DETAILS=${tableIds['Мои реквизиты'] || ''}
`;
  fs.writeFileSync(envPath, content.trim());
  console.log(`\n💾 Токены сохранены в ${envPath}`);
  console.log('\n═══════════════════════════════════════════');
  console.log('📋 СКОПИРУЙ ЭТИ ДАННЫЕ В .env НА ХОСТЕ:');
  console.log(content);
  console.log('═══════════════════════════════════════════');
}

(async () => {
  try {
    await waitForNocoDB();
    await createAdmin();
    await login();
    const projectId = await createProject();
    const tableIds = await createTables(projectId);
    await saveEnv(projectId, tableIds);
    console.log('\n✅ Инициализация завершена! Контейнер init остановится.');
  } catch (err) {
    console.error('❌ Критическая ошибка:', err.message);
    process.exit(1);
  }
})();
