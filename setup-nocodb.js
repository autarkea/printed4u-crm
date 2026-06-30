#!/usr/bin/env node

/**
 * Автоматическая настройка NocoDB
 * Создаёт все необходимые таблицы для Printed4U CRM
 */

const axios = require('axios');

// Загружаем переменные окружения
require('dotenv').config();

const NOCO_URL = process.env.NOCO_URL || 'http://nocodb:8080/api/v1/db/data';
const NOCO_TOKEN = process.env.NOCO_TOKEN;
const BASE_ID = process.env.BASE_ID;

if (!NOCO_TOKEN || !BASE_ID) {
    console.error('❌ Ошибка: NOCO_TOKEN и BASE_ID должны быть установлены в .env');
    console.error('   Сначала создайте базу данных в NocoDB и получите токены');
    process.exit(1);
}

const headers = {
    'xc-token': NOCO_TOKEN,
    'Content-Type': 'application/json'
};

// Структура таблиц
const tables = [
    {
        table_name: 'Задачи',
        title: 'Задачи',
        columns: [
            { title: 'Название', column_name: 'Название', uidt: 'singletext' },
            { title: 'Описание', column_name: 'Описание', uidt: 'longtext' },
            { title: 'Статус', column_name: 'Статус', uidt: 'singleselect', dtxp: "'Новая','В работе','Готово','Отменено'" },
            { title: 'Приоритет', column_name: 'Приоритет', uidt: 'singleselect', dtxp: "'Низкий','Средний','Высокий','Срочный'" },
            { title: 'Дедлайн', column_name: 'Дедлайн', uidt: 'datetime' },
            { title: 'Проект', column_name: 'Проект', uidt: 'singletext' },
            { title: 'Контакт', column_name: 'Контакт', uidt: 'singletext' },
            { title: 'Создано', column_name: 'Создано', uidt: 'datetime', cdf: 'NOW()' },
            { title: 'Обновлено', column_name: 'Обновлено', uidt: 'datetime', cdf: 'NOW()' }
        ]
    },
    {
        table_name: 'Контакты',
        title: 'Контакты',
        columns: [
            { title: 'Имя', column_name: 'Имя', uidt: 'singletext' },
            { title: 'Телефон', column_name: 'Телефон', uidt: 'phonenumber' },
            { title: 'Email', column_name: 'Email', uidt: 'email' },
            { title: 'Telegram', column_name: 'Telegram', uidt: 'singletext' },
            { title: 'Компания', column_name: 'Компания', uidt: 'singletext' },
            { title: 'Тип', column_name: 'Тип', uidt: 'singleselect', dtxp: "'Клиент','Партнёр','Поставщик'" },
            { title: 'Client ID', column_name: 'ClientID', uidt: 'singletext' },
            { title: 'Создано', column_name: 'Создано', uidt: 'datetime', cdf: 'NOW()' }
        ]
    },
    {
        table_name: 'Проекты',
        title: 'Проекты',
        columns: [
            { title: 'Название', column_name: 'Название', uidt: 'singletext' },
            { title: 'Контакт', column_name: 'Контакт', uidt: 'singletext' },
            { title: 'Статус', column_name: 'Статус', uidt: 'singleselect', dtxp: "'Новый','В работе','Завершён','Приостановлен'" },
            { title: 'Дата начала', column_name: 'Дата начала', uidt: 'datetime' },
            { title: 'Дата окончания', column_name: 'Дата окончания', uidt: 'datetime' },
            { title: 'Описание', column_name: 'Описание', uidt: 'longtext' },
            { title: 'Папка проекта', column_name: 'Папка проекта', uidt: 'singletext' },
            { title: 'Создано', column_name: 'Создано', uidt: 'datetime', cdf: 'NOW()' }
        ]
    },
    {
        table_name: 'Документы',
        title: 'Документы',
        columns: [
            { title: 'Название', column_name: 'Название', uidt: 'singletext' },
            { title: 'Тип', column_name: 'Тип', uidt: 'singleselect', dtxp: "'Счёт','Акт','Накладная','Договор'" },
            { title: 'Проект', column_name: 'Проект', uidt: 'singletext' },
            { title: 'Контакт', column_name: 'Контакт', uidt: 'singletext' },
            { title: 'Сумма', column_name: 'Сумма', uidt: 'number' },
            { title: 'Статус', column_name: 'Статус', uidt: 'singleselect', dtxp: "'Черновик','Отправлен','Оплачен','Подписан'" },
            { title: 'Дата', column_name: 'Дата', uidt: 'datetime' },
            { title: 'PDF путь', column_name: 'PDF путь', uidt: 'singletext' },
            { title: 'Создано', column_name: 'Создано', uidt: 'datetime', cdf: 'NOW()' }
        ]
    },
    {
        table_name: 'Позиции',
        title: 'Позиции',
        columns: [
            { title: 'Название', column_name: 'Название', uidt: 'singletext' },
            { title: 'Документ', column_name: 'Документ', uidt: 'singletext' },
            { title: 'Количество', column_name: 'Количество', uidt: 'number' },
            { title: 'Цена', column_name: 'Цена', uidt: 'number' },
            { title: 'Сумма', column_name: 'Сумма', uidt: 'number' },
            { title: 'Описание', column_name: 'Описание', uidt: 'longtext' }
        ]
    },
    {
        table_name: 'Юрлица',
        title: 'Юрлица',
        columns: [
            { title: 'Название', column_name: 'Название', uidt: 'singletext' },
            { title: 'ИНН', column_name: 'ИНН', uidt: 'singletext' },
            { title: 'КПП', column_name: 'КПП', uidt: 'singletext' },
            { title: 'ОГРН', column_name: 'ОГРН', uidt: 'singletext' },
            { title: 'Адрес', column_name: 'Адрес', uidt: 'longtext' },
            { title: 'Банк', column_name: 'Банк', uidt: 'singletext' },
            { title: 'Расчётный счёт', column_name: 'Расчётный счёт', uidt: 'singletext' },
            { title: 'Корр. счёт', column_name: 'Корр счёт', uidt: 'singletext' },
            { title: 'БИК', column_name: 'БИК', uidt: 'singletext' }
        ]
    },
    {
        table_name: 'Мои реквизиты',
        title: 'Мои реквизиты',
        columns: [
            { title: 'Название', column_name: 'Название', uidt: 'singletext' },
            { title: 'Юрлицо', column_name: 'Юрлицо', uidt: 'singletext' },
            { title: 'Директор', column_name: 'Директор', uidt: 'singletext' },
            { title: 'Телефон', column_name: 'Телефон', uidt: 'phonenumber' },
            { title: 'Email', column_name: 'Email', uidt: 'email' },
            { title: 'Сайт', column_name: 'Сайт', uidt: 'url' }
        ]
    }
];

async function setupNocoDB() {
    console.log('🚀 Начинаю настройку NocoDB...');
    console.log(`📡 URL: ${NOCO_URL}`);
    console.log(`🔑 Base ID: ${BASE_ID}`);
    console.log('');

    for (const table of tables) {
        try {
            console.log(`📋 Создаю таблицу: ${table.title}...`);
            
            const response = await axios.post(
                `${NOCO_URL}/meta/tables`,
                {
                    table_name: table.table_name,
                    title: table.title,
                    columns: table.columns
                },
                { headers }
            );

            const tableId = response.data.id;
            console.log(`   ✅ Создана (ID: ${tableId})`);
            
            // Сохраняем ID в .env
            const envVar = `TABLE_${table.table_name.toUpperCase().replace(/[^A-ZА-Я0-9]/g, '_')}`;
            console.log(`   💾 Сохраняю в .env: ${envVar}=${tableId}`);
            
        } catch (error) {
            if (error.response && error.response.status === 400) {
                console.log(`   ⚠️  Таблица уже существует, пропускаю`);
            } else {
                console.error(`   ❌ Ошибка: ${error.message}`);
            }
        }
    }

    console.log('');
    console.log('✅ Настройка NocoDB завершена!');
    console.log('');
    console.log('📋 Следующие шаги:');
    console.log('1. Отредактируй .env и добавь ID таблиц');
    console.log('2. Перезапусти контейнеры: docker compose restart');
}

setupNocoDB().catch(error => {
    console.error('❌ Критическая ошибка:', error.message);
    process.exit(1);
});
