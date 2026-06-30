module.exports = {
    // Telegram
    TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    MY_ID: parseInt(process.env.TELEGRAM_USER_ID),
    CRON_TIME: process.env.MORNING_CRON || '0 10 * * *',
    
    // NocoDB
    NOCO_URL: process.env.NOCO_URL || 'http://nocodb:8080/api/v1/db/data',
    NOCO_TOKEN: process.env.NOCO_TOKEN,
    BASE_ID: process.env.BASE_ID,
    
    // Таблицы (ID будут найдены автоматически при первом запуске!)
    TABLES: {
        TASKS: process.env.TABLE_TASKS,
        CONTACTS: process.env.TABLE_CONTACTS,
        PROJECTS: process.env.TABLE_PROJECTS,
        DOCUMENTS: process.env.TABLE_DOCUMENTS,
        ITEMS: process.env.TABLE_ITEMS,
        LEGAL_ENTITIES: process.env.TABLE_LEGAL_ENTITIES,
        MY_DETAILS: process.env.TABLE_MY_DETAILS
    },
    
    VALID_MESSENGERS: ['Telegram', 'Viber', 'Куфар']
};
