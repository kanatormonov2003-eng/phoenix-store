# Phoenix Style House

React + Vite проект интернет-магазина Phoenix.

## Структура

```
phoenix-store/
├── index.html
├── package.json
├── vite.config.js
├── src/
│   ├── main.jsx
│   └── phoenix-store.jsx   ← весь код приложения (компоненты, i18n, админка, корзина, купоны, GlobalStyles)
└── public/
```

## Запуск локально

```bash
npm install
npm run dev
```

Откроется на http://localhost:5173

## Сборка

```bash
npm run build
npm run preview
```

## Деплой

Проект собирается стандартной командой `npm run build` (папка `dist/`) и готов к деплою на **Vercel** или **Netlify** без дополнительной настройки:

- **Vercel**: Framework Preset — Vite, Build Command — `npm run build`, Output Directory — `dist`
- **Netlify**: Build Command — `npm run build`, Publish Directory — `dist`

## Данные

Приложение хранит товары, корзину, заказы, купоны и настройки в `localStorage` браузера (ключи `phoenix_*`), поэтому дополнительный backend не требуется.
