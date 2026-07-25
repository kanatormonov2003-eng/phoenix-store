import { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext, Fragment } from "react";
import {
  Search, ShoppingBag, Menu, X, ChevronDown, ChevronRight, Trash2, Pencil,
  Plus, Minus, Lock, LogOut, Check, ArrowRight, ArrowLeft, Sparkles, Shirt,
  Footprints, Mail, Phone, MapPin, Clock, ImagePlus, LayoutGrid, Settings,
  PackagePlus, AlertCircle, Loader2, Globe, Coins, Receipt, TicketPercent,
  PackageX, TrendingUp, ChevronUp
} from "lucide-react";

/* =========================================================================
   CONSTANTS
   ========================================================================= */

const STORAGE_KEYS = {
  PRODUCTS: "phoenix_products_v2",
  CART: "phoenix_cart_v1",
  ADMIN_CONFIG: "phoenix_admin_config_v1",
  ADMIN_SESSION: "phoenix_admin_session_v1",
  ORDERS: "phoenix_orders_v1",
  COUPONS: "phoenix_coupons_v1",
  SETTINGS: "phoenix_settings_v1",
  LANG: "phoenix_lang_v1",
  CURRENCY: "phoenix_currency_v1",
};

const CATEGORIES = ["Clothing", "Shoes", "Other"];

const CATEGORY_META = {
  Clothing: { icon: Shirt, color: "var(--coral)" },
  Shoes: { icon: Footprints, color: "var(--teal-light)" },
  Other: { icon: Sparkles, color: "var(--gold)" },
};

/* Prices are stored in the base currency (KGS). Shipping figures below are
   also in KGS so they scale sensibly against real product prices. */
const SHIPPING_FLAT = 250;
const FREE_SHIPPING_THRESHOLD = 8000;

const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/* =========================================================================
   INTERNATIONALIZATION
   The store ships with Russian and Kyrgyz today. Adding another language
   later means: (1) add its code to LANGUAGES, (2) add a matching block to
   `translations`, (3) optionally add per-product fields in that language —
   nothing else in the app needs to change.
   ========================================================================= */

const LANGUAGES = [
  { code: "ru", name: "Русский", short: "RU" },
  { code: "ky", name: "Кыргызча", short: "KY" },
];
const FALLBACK_LANG = "ru";

const BASE_CURRENCY = "KGS";
const CURRENCIES = [
  { code: "KGS", symbol: "сом" },
  { code: "RUB", symbol: "₽" },
];
const DEFAULT_EXCHANGE_RATE_RUB_PER_KGS = 0.95; // editable from Admin → Settings

const ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];
const PAYMENT_METHODS = ["cod", "card_on_delivery", "bank_transfer"];

/* =========================================================================
   HELPERS
   ========================================================================= */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatDate(d, lang = FALLBACK_LANG) {
  try {
    return new Date(d).toLocaleDateString(lang === "ky" ? "ky-KG" : "ru-RU", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return d;
  }
}

/* Localized-field reader. Product `name`/`description` can either be a plain
   string (legacy data, or content that hasn't been translated yet) or an
   object like { ru: "...", ky: "..." }. Either shape works everywhere. */
function L(field, lang) {
  if (field == null) return "";
  if (typeof field === "string") return field;
  return field[lang] ?? field[FALLBACK_LANG] ?? Object.values(field)[0] ?? "";
}

/* Russian noun pluralization (1 товар / 2 товара / 5 товаров). Kyrgyz nouns
   don't inflect after a numeral, so callers just use the plain noun there. */
function pluralRu(n, [one, few, many]) {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/* Currency conversion + locale-aware formatting. Amounts are always stored
   in KGS; `rate` is RUB per 1 KGS, configurable from Admin → Settings so the
   architecture is ready to be wired up to a live exchange-rate feed later. */
function convertFromBase(amountKgs, currency, rate) {
  return currency === "RUB" ? Number(amountKgs) * rate : Number(amountKgs);
}
function formatMoneyRaw(amountKgs, currency, lang, rate) {
  const amount = convertFromBase(amountKgs, currency, rate);
  const locale = currency === "RUB" ? "ru-RU" : (lang === "ky" ? "ky-KG" : "ru-KG");
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString()} ${currency}`;
  }
}

/* Coupon engine. Coupons are stored flat: { id, code, type: "percentage"|"fixed",
   value, active, expiresAt, minOrder, usageLimit, timesUsed }. Discount is
   always computed against the pre-shipping subtotal and never exceeds it. */
function findCoupon(coupons, code) {
  const norm = (code || "").trim().toUpperCase();
  if (!norm) return null;
  return coupons.find((c) => c.code.trim().toUpperCase() === norm) || null;
}

function validateCoupon(coupon, subtotal) {
  if (!coupon) return { ok: false, reason: "invalid" };
  if (!coupon.active) return { ok: false, reason: "inactive" };
  if (coupon.expiresAt) {
    const exp = new Date(coupon.expiresAt);
    exp.setHours(23, 59, 59, 999);
    if (Date.now() > exp.getTime()) return { ok: false, reason: "expired" };
  }
  if (coupon.usageLimit && Number(coupon.timesUsed || 0) >= Number(coupon.usageLimit)) {
    return { ok: false, reason: "limitReached" };
  }
  if (coupon.minOrder && subtotal < Number(coupon.minOrder)) {
    return { ok: false, reason: "minOrder" };
  }
  return { ok: true };
}

function computeDiscount(coupon, subtotal) {
  if (!coupon) return 0;
  const raw = coupon.type === "fixed" ? Number(coupon.value) : (subtotal * Number(coupon.value)) / 100;
  return Math.max(0, Math.min(subtotal, Math.round(raw)));
}

function placeholderImage(name, category) {
  const palettes = {
    Clothing: ["#FF6B4A", "#E3A63C"],
    Shoes: ["#0E4F52", "#1C7A7E"],
    Other: ["#E3A63C", "#FF6B4A"],
  };
  const [c1, c2] = palettes[category] || ["#0E4F52", "#FF6B4A"];
  const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='640' viewBox='0 0 100 100'>
    <defs>
      <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
        <stop offset='0' stop-color='${c1}'/>
        <stop offset='1' stop-color='${c2}'/>
      </linearGradient>
    </defs>
    <rect width='100' height='100' fill='url(#g)'/>
    <circle cx='78' cy='18' r='26' fill='rgba(255,255,255,0.08)'/>
    <circle cx='16' cy='88' r='30' fill='rgba(0,0,0,0.07)'/>
    <text x='50' y='61' font-family='Georgia, Cambria, serif' font-style='italic' font-size='40' fill='rgba(255,255,255,0.88)' text-anchor='middle'>${letter}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function defaultProducts() {
  const days = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const base = [
    { category: "Clothing", price: 5490, days: 2, stock: 14,
      name: { ru: "Коралловое платье-миди на запах", ky: "Коралл түстүү ороп кийилуучу миди көйнөк" },
      description: { ru: "Текучий силуэт миди из дышащего крепа, скроенный по косой линии, чтобы двигаться вместе с вами. Пояс на завязке, боковые карманы, подшитый вручную низ.",
        ky: "Дем алган креп кездемеден жасалган, ийкем миди узундуктагы көйнөк. Боо менен байланган бел, эки капталында чөнтөк, этеги колдо тигилген." } },
    { category: "Clothing", price: 4290, days: 9, stock: 22,
      name: { ru: "Классическая белая рубашка оксфорд", ky: "Классикалык ак оксфорд көйнөк" },
      description: { ru: "Строгая рубашка из плотного оксфорда, сотканного из длинноволокнистого хлопка. Пуговицы из перламутра и слегка свободный воротник для повседневной носки.",
        ky: "Узун булалуу пахтадан токулган тыгыз оксфорд кездемеден жасалган. Седеп топчолор жана күнүмдүк кийүү үчүн бир аз эркин жака." } },
    { category: "Clothing", price: 5790, days: 15, stock: 3,
      name: { ru: "Широкие брюки Studio", ky: "Кенен балактуу Studio шым" },
      description: { ru: "Брюки с высокой посадкой, глубокими складками спереди и текучим силуэтом. Полностью на подкладке в области бёдер — от офиса до ужина без единой заминки.",
        ky: "Бели бийик, алдында терең бүктөлгөн, эркин түшкөн шым. Жамбаш тарабы толугу менен астары менен — кеңседен кечки чогулушка чейин ыңгайлуу." } },
    { category: "Shoes", price: 7590, days: 1, stock: 8,
      name: { ru: "Высокие кроссовки Ember", ky: "Ember бийик кроссовкалары" },
      description: { ru: "Мягкий верх из нубука, амортизирующая подошва из каучука. Созданы для городских улиц и подходят к любому образу.",
        ky: "Жумшак нубук материалдан жасалган, резина табаны жумшартылган. Шаар көчөлөрү үчүн ыңгайлуу жана каалаган стилге туура келет." } },
    { category: "Shoes", price: 9990, days: 6, stock: 0,
      name: { ru: "Ботильоны с золотой пряжкой", ky: "Алтын тогочо менен ботильондор" },
      description: { ru: "Ботильоны на устойчивом каблуке из мягкой кожи с золотистой пряжкой. Такая обувь завершает образ без лишних усилий.",
        ky: "Жумшак булгаарыдан жасалган, туруктуу өкчөлүү, алтын түстүү тогочолуу ботильондор. Бул бут кийим образды өзү эле толуктайт." } },
    { category: "Shoes", price: 4590, days: 20, stock: 17,
      name: { ru: "Слипоны из тёмно-бирюзовой парусины", ky: "Көгүш парусин слипондор" },
      description: { ru: "Лёгкие парусиновые слипоны с амортизирующей стелькой. Легко надеть, легко снять — и легко полюбить на весь сезон.",
        ky: "Жеңил парусин кездемеден жасалган, жумшак ички табаны бар слипондор. Кийүүсү да, чечүүсү да оңой — бүт сезон бою жакшы көрөсүз." } },
    { category: "Other", price: 3690, days: 4, stock: 4,
      name: { ru: "Плетёная соломенная сумка-тоут", ky: "Өрүлгөн саман сумка" },
      description: { ru: "Сумка ручного плетения из соломы с ручкой, обёрнутой кожей, и внутренним карманом на молнии. Достаточно вместительная для всего, что вы не планировали брать с собой.",
        ky: "Колдо өрүлгөн саман сумка, тутка жагы булгаары менен ороолгон, ичинде молниялуу чөнтөгү бар. Пландабаган нерселериңиздин баарын батырат." } },
    { category: "Other", price: 2990, days: 12, stock: 30,
      name: { ru: "Шёлковый платок Sunset", ky: "Sunset жибек жоолук" },
      description: { ru: "Невесомый шёлковый платок с градиентным принтом, нарисованным вручную. Носите на шее, на запястье или завяжите на ручке сумки.",
        ky: "Колдо тартылган градиент принти бар, жеңил жибек жоолук. Мойнуңузга, билегиңизге тагыңыз же сумканын тутказынан байлаңыз." } },
  ];
  return base.map((p) => ({
    id: uid(),
    name: p.name,
    description: p.description,
    price: p.price,
    category: p.category,
    image: placeholderImage(L(p.name, FALLBACK_LANG), p.category),
    date_added: days(p.days),
    stock: p.stock,
    lowStockThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
  }));
}

function resizeImageFile(file, maxWidth = 900, quality = 0.78) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("No file"));
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Could not read image"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

/* Storage wrappers — products & admin config are shared across everyone
   viewing this store; cart & admin session are private to this browser.
   Works two ways:
   - Inside the Artifact environment, window.storage is available and
     shared=true data is visible to every visitor.
   - Run locally (e.g. with Vite) window.storage doesn't exist, so we
     fall back to localStorage automatically. In that mode "shared"
     data just lives in this browser's localStorage instead. */

function hasArtifactStorage() {
  return typeof window !== "undefined" && window.storage && typeof window.storage.get === "function";
}

async function storageGet(key, shared, fallback) {
  try {
    if (hasArtifactStorage()) {
      const res = await window.storage.get(key, shared);
      return res ? JSON.parse(res.value) : fallback;
    }
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(key);
      return raw != null ? JSON.parse(raw) : fallback;
    }
    return fallback;
  } catch {
    return fallback;
  }
}
async function storageSet(key, value, shared) {
  try {
    if (hasArtifactStorage()) {
      await window.storage.set(key, JSON.stringify(value), shared);
      return;
    }
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    /* best effort */
  }
}

/* =========================================================================
   TRANSLATIONS
   ========================================================================= */

const translations = {
  ru: {
    common: {
      cancel: "Отмена", save: "Сохранить", delete: "Удалить", edit: "Изменить", add: "Добавить",
      update: "Обновить", active: "Активен", inactive: "Отключён", yes: "Да", no: "Нет",
      close: "Закрыть", apply: "Применить", remove: "Убрать", back: "Назад", optional: "необязательно",
      currency: "Валюта", language: "Язык", loading: "Загрузка Phoenix…",
      decrease: "Уменьшить", increase: "Увеличить", expand: "Развернуть", preview: "Просмотр",
    },
    nav: { home: "Главная", shop: "Каталог", about: "О нас", storeOwner: "Владелец магазина", adminDashboard: "Панель управления" },
    header: { searchAria: "Поиск", cartAria: "Корзина", ownerAria: "Владелец магазина", menuAria: "Меню" },
    search: { placeholder: "Платья, кроссовки, шарфы…" },
    cart: {
      title: "Ваша сумка", emptyTitle: "Ваша сумка пуста", emptyBody: "Добавьте то, что вам понравится.",
      browseShop: "В каталог", subtotal: "Промежуточный итог", taxNote: "Доставка и налоги рассчитываются при оформлении заказа.",
      checkout: "Оформить заказ", viewFullBag: "Открыть корзину",
    },
    home: {
      eyebrow: "Новая коллекция", heroTitlePre: "Найдите ", heroTitleEm: "свой", heroTitlePost: " следующий любимый образ.",
      lead: "Продуманная одежда, обувь и завершающие детали для тех, кто начинает новую главу — созданы служить дольше одного сезона.",
      shopCollection: "Смотреть коллекцию", ourStory: "Наша история",
      pieceOne: "вещь", pieceFew: "вещи", pieceMany: "вещей",
      justIn: "Новинки", newArrivals: "Новые поступления", viewAll: "Смотреть все",
      noProductsTitle: "Пока нет товаров", noProductsBody: "Загляните позже — новые вещи уже в пути.",
      valueDesignTitle: "Продуманный дизайн", valueDesignBody: "Каждая вещь выбрана не только за внешний вид, но и за то, как она носится.",
      valueLastTitle: "Создано надолго", valueLastBody: "Настоящие материалы и честный пошив — на годы вперёд.",
      valueExchangeTitle: "Лёгкий обмен", valueExchangeBody: "Не тот размер? Мы всё исправим — без сложных форм.",
      ctaTitle: "Готовы найти новый любимый образ?", ctaButton: "Начать покупки", featured: "Рекомендуем",
    },
    category: { Clothing: "Одежда", Shoes: "Обувь", Other: "Аксессуары" },
    catalog: {
      eyebrow: "Вся коллекция", title: "Каталог Phoenix", searchPlaceholder: "Поиск товаров…",
      showFilters: "Показать фильтры", hideFilters: "Скрыть фильтры",
      categoryHeading: "Категория", priceHeading: "Цена", clearFilters: "Сбросить все фильтры",
      productOne: "товар", productFew: "товара", productMany: "товаров",
      noMatchTitle: "Ничего не найдено", noMatchBody: "Попробуйте другой запрос или сбросьте фильтры.", clearFiltersAction: "Сбросить фильтры",
    },
    sort: { newest: "Сначала новые", priceAsc: "Сначала дешевле", priceDesc: "Сначала дороже", name: "По названию А-Я" },
    product: {
      addToBag: "Добавить в сумку", backToShop: "Назад в каталог", related: "Вам может понравиться",
      notFoundTitle: "Товар не найден", notFoundBody: "Возможно, эта вещь была снята с продажи.",
      outOfStock: "Нет в наличии", lowStock: "Осталось мало", inStock: "В наличии",
      breadcrumbHome: "Главная", breadcrumbShop: "Каталог",
    },
    cartPage: {
      title: "Ваша сумка", emptyTitle: "В сумке пока пусто", emptyBody: "Загляните в каталог и найдите что-то стоящее.", shopNow: "В каталог",
      remove: "Убрать", continueShopping: "Продолжить покупки", summary: "Итог заказа",
      subtotal: "Промежуточный итог", shipping: "Доставка", free: "Бесплатно",
      freeShippingNote: "Бесплатная доставка при заказе от {amount}.", total: "Итого",
      proceed: "Перейти к оформлению",
    },
    checkout: {
      emptyTitle: "Нечего оформлять", emptyBody: "Сначала добавьте что-нибудь в сумку.", shopNow: "В каталог",
      title: "Оформление заказа", contact: "Контактные данные", fullName: "Полное имя", phone: "Телефон", email: "Email",
      delivery: "Доставка", address: "Адрес", city: "Город", note: "Комментарий к заказу",
      notePlaceholder: "Пожелания к доставке, подарочная открытка и т.д.",
      namePlaceholder: "Айгерим Нурланова", addressPlaceholder: "Улица, дом, квартира", cityPlaceholder: "Ош",
      errName: "Введите ваше полное имя.", errEmail: "Введите корректный email.", errPhone: "Введите номер телефона.",
      errAddress: "Введите адрес доставки.", errCity: "Введите город.",
      placeOrder: "Оформить заказ", summary: "Итог заказа",
      confirmedTitle: "Заказ подтверждён", confirmedThanks: "Спасибо, {name} — мы получили ваш заказ.",
      confirmedFollowUp: "Наша команда свяжется с вами в течение 24 часов, чтобы подтвердить оплату и детали доставки.",
      backHome: "На главную", paymentMethod: "Способ оплаты",
    },
    payment: { cod: "Наличными при получении", card_on_delivery: "Картой при получении", bank_transfer: "Банковский перевод" },
    coupon: {
      label: "Есть промокод?", placeholder: "Введите промокод", apply: "Применить", remove: "Убрать",
      applied: "Промокод «{code}» применён", invalid: "Такой промокод не найден.", inactive: "Этот промокод больше не действует.",
      expired: "Срок действия промокода истёк.", limitReached: "Лимит использований промокода исчерпан.",
      minOrder: "Минимальная сумма заказа для этого промокода — {amount}.", discount: "Скидка",
    },
    about: {
      eyebrow: "Наша история", titlePre: "Создано в Оше, носят ", titleEm: "везде", titlePost: ".",
      lead: "Phoenix начинался как небольшая коллекция вещей, которые нельзя было найти больше нигде — одежда, обувь и детали для тех, кто готов начать что-то новое. Каждый товар мы выбираем так, как выбрали бы для себя: чтобы служил долго, легко полюбился и стоил того, чтобы ради него подняться.",
      renewalTitle: "Обновление", renewalBody: "Каждая коллекция — новый старт: ничего не остаётся на полке по привычке.",
      qualityTitle: "Качество", qualityBody: "Мы проверяем каждую вещь вручную перед тем, как она попадёт к вам.",
      craftTitle: "Мастерство", craftBody: "Небольшие партии, тесные отношения с мастерами, никаких компромиссов.",
      getInTouch: "Свяжитесь с нами", loveToHear: "Будем рады вашему сообщению",
      emailLabel: "Email", phoneLabel: "Телефон", showroomLabel: "Шоурум", hoursLabel: "Часы работы",
      hoursValue: "Пн–Сб, 10:00–19:00", showroomValue: "Ош, Кыргызстан", formName: "Имя", formEmail: "Email", formMessage: "Сообщение",
      formNamePlaceholder: "Ваше имя", formMessagePlaceholder: "Чем мы можем помочь?", send: "Отправить сообщение", sent: "Сообщение отправлено ✓",
    },
    adminLogin: {
      setupTitle: "Настройка доступа администратора", loginTitle: "Вход для владельца магазина",
      setupSub: "Придумайте пароль для управления каталогом Phoenix. Он подойдёт всем, у кого он есть, поэтому храните его в секрете.",
      loginSub: "Доступ только для владельца магазина.",
      errShort: "Пароль должен содержать не менее 6 символов.", errMatch: "Пароли не совпадают.", errWrong: "Неверный пароль. Попробуйте снова.",
      password: "Пароль", confirmPassword: "Подтвердите пароль", createPassword: "Создать пароль", logIn: "Войти", backHome: "Назад в Phoenix",
    },
    productForm: {
      image: "Изображение товара", changeImage: "Изменить изображение", uploadImage: "Загрузить изображение",
      noImageNote: "Нет изображения? Мы создадим заглушку автоматически.",
      nameLabel: "Название товара", namePlaceholder: "Например, платье-миди",
      priceLabel: "Цена (KGS)", categoryLabel: "Категория", descriptionLabel: "Описание",
      descriptionPlaceholder: "Опишите крой, ткань и детали, которые важно знать покупателю.",
      stockLabel: "Остаток на складе", lowStockLabel: "Порог низкого остатка",
      errName: "Укажите название товара.", errPrice: "Введите цену больше 0.", errCategory: "Выберите категорию.",
      errStock: "Укажите остаток на складе (0 или больше).",
      errImage: "Не удалось прочитать изображение — попробуйте другой файл.",
      update: "Обновить товар", addProduct: "Добавить товар", cancel: "Отмена",
      langTabHint: "Заполните название и описание на каждом языке.",
    },
    admin: {
      title: "Управление Phoenix", subtitle: "Панель владельца", logout: "Выйти",
      tabOverview: "Обзор", tabProducts: "Товары", tabOrders: "Заказы", tabInventory: "Склад", tabCoupons: "Промокоды",
      tabAnalytics: "Аналитика", tabAdd: "Добавить товар", tabSettings: "Настройки",
      statTotalProducts: "Всего товаров", statInventoryValue: "Стоимость запасов", statRevenue: "Выручка",
      statOrders: "Заказов", statAvgOrder: "Средний чек", statLowStock: "Мало на складе",
      lowStockHeading: "Заканчиваются на складе", outOfStockHeading: "Нет в наличии",
      topProductsHeading: "Лидеры продаж", noSalesYet: "Продаж пока нет.",
      searchInventory: "Поиск по товарам…", noProductsTitle: "Товары не найдены", noProductsBody: "Измените запрос или добавьте первый товар.",
      colProduct: "Товар", colCategory: "Категория", colPrice: "Цена", colStock: "Остаток", colAdded: "Добавлен",
      confirmDeleteProductTitle: "Удалить этот товар?", confirmDeleteProductBody: "«{name}» будет удалён из каталога без возможности восстановления.",
      ordersEmptyTitle: "Заказов пока нет", ordersEmptyBody: "Заказы покупателей появятся здесь.",
      allStatuses: "Все статусы",
      colOrder: "Заказ", colCustomer: "Покупатель", colDate: "Дата", colItems: "Товары", colTotal: "Сумма", colStatus: "Статус", colPayment: "Оплата",
      status: { pending: "Ожидает", processing: "В обработке", shipped: "Отправлен", delivered: "Доставлен", cancelled: "Отменён" },
      orderDetailCustomer: "Покупатель", orderDetailDelivery: "Доставка", orderDetailNote: "Комментарий", orderDetailNoNote: "Без комментария",
      orderDetailCoupon: "Промокод", orderDetailItems: "Состав заказа",
      couponsEmptyTitle: "Промокодов пока нет", couponsEmptyBody: "Создайте первый промокод для покупателей.",
      addCoupon: "Добавить промокод", editCoupon: "Изменить промокод",
      colCode: "Код", colType: "Тип", colValue: "Значение", colExpires: "Действует до", colUses: "Использований", colActiveState: "Статус",
      typePercentage: "Процент", typeFixed: "Фиксированная сумма",
      couponCodeLabel: "Код промокода", couponCodePlaceholder: "SUMMER10", couponTypeLabel: "Тип скидки",
      couponValueLabel: "Значение", couponMinOrderLabel: "Мин. сумма заказа", couponExpiryLabel: "Действует до (необязательно)",
      couponLimitLabel: "Лимит использований (необязательно)", couponActiveLabel: "Промокод активен",
      confirmDeleteCouponTitle: "Удалить этот промокод?", confirmDeleteCouponBody: "Код «{code}» будше нельзя будет использовать.",
      settingsPasswordHeading: "Смена пароля администратора", currentPassword: "Текущий пароль", newPassword: "Новый пароль", confirmNewPassword: "Подтвердите новый пароль",
      updatePassword: "Обновить пароль", errCurrentWrong: "Текущий пароль указан неверно.", errNewShort: "Новый пароль должен содержать не менее 6 символов.",
      errNewMatch: "Новые пароли не совпадают.", passwordUpdated: "Пароль обновлён.",
      settingsStoreHeading: "Настройки магазина", defaultLanguage: "Язык по умолчанию", defaultCurrency: "Валюта по умолчанию",
      exchangeRateLabel: "Курс обмена (1 KGS = ? RUB)", exchangeRateHint: "Задаётся вручную сейчас; архитектура готова к подключению курса в реальном времени.",
      saveSettings: "Сохранить настройки", settingsSaved: "Настройки сохранены.",
    },
    inventory: {
      title: "Управление складом", subtitle: "Следите за остатками и вовремя пополняйте запасы.",
      lowStockAlert: "Товары заканчиваются", outOfStockAlert: "Нет в наличии", allGood: "Все остальные товары в достаточном количестве.",
      colProduct: "Товар", colStock: "Остаток", colThreshold: "Порог", colStatus: "Статус", colActions: "Действия",
      statusOk: "В наличии", statusLow: "Мало", statusOut: "Нет в наличии",
      increase: "Добавить", decrease: "Списать", stockUpdated: "Остаток обновлён",
    },
    analytics: {
      title: "Аналитика", subtitle: "Показатели магазина на основе сохранённых заказов и товаров.",
      totalProducts: "Всего товаров", totalOrders: "Всего заказов", revenue: "Выручка", lowStockItems: "Мало на складе",
      ordersByStatus: "Заказы по статусу", revenueByCategory: "Выручка по категориям", noData: "Пока недостаточно данных.",
    },
    footer: {
      tagline: "Продуманная одежда, обувь и завершающие детали из Оша, Кыргызстан.",
      emailPlaceholder: "Ваш email", join: "Подписаться", joined: "Готово ✓",
      shopHeading: "Каталог", allProducts: "Все товары", companyHeading: "Компания",
      aboutUs: "О нас", contact: "Контакты", storeOwner: "Владелец магазина",
      visitUs: "Приходите к нам", locationValue: "Ош, Кыргызстан", hours: "Пн–Сб, 10:00–19:00", rights: "Все права защищены.", craftedIn: "Сделано с любовью в Оше.",
    },
  },
  ky: {
    common: {
      cancel: "Жокко чыгаруу", save: "Сактоо", delete: "Өчүрүү", edit: "Оңдоо", add: "Кошуу",
      update: "Жаңыртуу", active: "Иштейт", inactive: "Өчүрүлгөн", yes: "Ооба", no: "Жок",
      close: "Жабуу", apply: "Колдонуу", remove: "Алып салуу", back: "Артка", optional: "милдеттүү эмес",
      currency: "Валюта", language: "Тил", loading: "Phoenix жүктөлүүдө…",
      decrease: "Азайтуу", increase: "Көбөйтүү", expand: "Жайып көрсөтүү", preview: "Алдын ала көрүү",
    },
    nav: { home: "Башкы бет", shop: "Каталог", about: "Биз жөнүндө", storeOwner: "Дүкөн ээси", adminDashboard: "Башкаруу панели" },
    header: { searchAria: "Издөө", cartAria: "Себет", ownerAria: "Дүкөн ээси", menuAria: "Меню" },
    search: { placeholder: "Көйнөк, кроссовка, жоолук…" },
    cart: {
      title: "Сиздин себетиңиз", emptyTitle: "Себетиңиз бош", emptyBody: "Жаккан нерсени кошуп көрүңүз.",
      browseShop: "Каталогго өтүү", subtotal: "Аралык сумма", taxNote: "Жеткирүү жана салыктар тапшырыкты тастыктоодо эсептелет.",
      checkout: "Тапшырыкты тастыктоо", viewFullBag: "Себетти ачуу",
    },
    home: {
      eyebrow: "Жаңы коллекция", heroTitlePre: "Өзүңүздүн ", heroTitleEm: "жаңы", heroTitlePost: " сүйүктүү образыңызды табыңыз.",
      lead: "Жаңы баракты ачкандар үчүн ойлонулган кийим, бут кийим жана толуктоочу буюмдар — бир сезондон узакка кызмат кылуу үчүн жасалган.",
      shopCollection: "Коллекцияны көрүү", ourStory: "Биздин тарых",
      pieceOne: "буюм", pieceFew: "буюм", pieceMany: "буюм",
      justIn: "Жаңылары", newArrivals: "Жаңы келгендер", viewAll: "Баарын көрүү",
      noProductsTitle: "Азырынча товар жок", noProductsBody: "Бир аздан кийин кайра кириңиз — жаңы буюмдар жолдо.",
      valueDesignTitle: "Ойлонулган дизайн", valueDesignBody: "Ар бир буюм сырткы көрүнүшү үчүн эмес, кийилиши үчүн тандалат.",
      valueLastTitle: "Узакка кызмат кылат", valueLastBody: "Чыныгы материалдар жана так тигүү — көп жылдарга.",
      valueExchangeTitle: "Оңой алмаштыруу", valueExchangeBody: "Өлчөмү туура келбей калдыбы? Татаал форма толтурбай эле оңдойбуз.",
      ctaTitle: "Жаңы сүйүктүү буюмуңузду табууга даярсызбы?", ctaButton: "Сатып алууну баштоо", featured: "Сунуштайбыз",
    },
    category: { Clothing: "Кийим", Shoes: "Бут кийим", Other: "Аксессуарлар" },
    catalog: {
      eyebrow: "Толук коллекция", title: "Phoenix каталогу", searchPlaceholder: "Товарларды издөө…",
      showFilters: "Чыпкаларды көрсөтүү", hideFilters: "Чыпкаларды жашыруу",
      categoryHeading: "Категория", priceHeading: "Баасы", clearFilters: "Бардык чыпкаларды тазалоо",
      productOne: "товар", productFew: "товар", productMany: "товар",
      noMatchTitle: "Эч нерсе табылган жок", noMatchBody: "Башка сөз менен издеп көрүңүз же чыпкаларды тазалаңыз.", clearFiltersAction: "Чыпкаларды тазалоо",
    },
    sort: { newest: "Жаңылары адегенде", priceAsc: "Арзандан кымбатка", priceDesc: "Кымбаттан арзанга", name: "Аты боюнча А-Я" },
    product: {
      addToBag: "Себетке кошуу", backToShop: "Каталогго кайтуу", related: "Сизге жагышы мүмкүн",
      notFoundTitle: "Товар табылган жок", notFoundBody: "Бул буюм сатуудан алынып салынган болушу мүмкүн.",
      outOfStock: "Сатылып бүттү", lowStock: "Аз калды", inStock: "Бар",
      breadcrumbHome: "Башкы бет", breadcrumbShop: "Каталог",
    },
    cartPage: {
      title: "Сиздин себетиңиз", emptyTitle: "Себет азырынча бош", emptyBody: "Каталогго кирип, жагышыңыз мүмкүн нерсени табыңыз.", shopNow: "Каталогго өтүү",
      remove: "Алып салуу", continueShopping: "Соода кылууну улантуу", summary: "Тапшырыктын жыйынтыгы",
      subtotal: "Аралык сумма", shipping: "Жеткирүү", free: "Акысыз",
      freeShippingNote: "{amount} ашкан тапшырыктарга жеткирүү акысыз.", total: "Жалпы сумма",
      proceed: "Тастыктоого өтүү",
    },
    checkout: {
      emptyTitle: "Тастыктай турган нерсе жок", emptyBody: "Адегенде себетке бир нерсе кошуңуз.", shopNow: "Каталогго өтүү",
      title: "Тапшырыкты тастыктоо", contact: "Байланыш маалыматы", fullName: "Толук аты-жөнү", phone: "Телефон", email: "Email",
      delivery: "Жеткирүү", address: "Дареги", city: "Шаар", note: "Тапшырыкка эскертүү",
      notePlaceholder: "Жеткирүү боюнча каалоолор, белек баракчасы ж.б.",
      namePlaceholder: "Айгерим Нурланова", addressPlaceholder: "Көчө, там, батир", cityPlaceholder: "Ош",
      errName: "Толук атыңызды жазыңыз.", errEmail: "Туура email дарегин жазыңыз.", errPhone: "Телефон номериңизди жазыңыз.",
      errAddress: "Жеткирүү дарегин жазыңыз.", errCity: "Шаарыңызды жазыңыз.",
      placeOrder: "Тапшырык берүү", summary: "Тапшырыктын жыйынтыгы",
      confirmedTitle: "Тапшырык кабыл алынды", confirmedThanks: "Рахмат, {name} — биз сиздин тапшырыгыңызды алдык.",
      confirmedFollowUp: "Биздин команда төлөм жана жеткирүү чоо-жайын тактоо үчүн 24 сааттын ичинде сиз менен байланышат.",
      backHome: "Башкы бетке", paymentMethod: "Төлөм ыкмасы",
    },
    payment: { cod: "Алганда накталай төлөө", card_on_delivery: "Алганда карта менен төлөө", bank_transfer: "Банк аркылуу которуу" },
    coupon: {
      label: "Промокодуңуз барбы?", placeholder: "Промокодду киргизиңиз", apply: "Колдонуу", remove: "Алып салуу",
      applied: "«{code}» промокоду колдонулду", invalid: "Мындай промокод табылган жок.", inactive: "Бул промокод эми иштебейт.",
      expired: "Промокоддун мөөнөтү өтүп кеткен.", limitReached: "Промокоддун колдонуу лимити бүттү.",
      minOrder: "Бул промокод үчүн тапшырыктын минималдуу суммасы — {amount}.", discount: "Арзандатуу",
    },
    about: {
      eyebrow: "Биздин тарых", titlePre: "Ош шаарында жаралып, ", titleEm: "бардык жерде", titlePost: " кийилет.",
      lead: "Phoenix башка эч жерден таппай турган буюмдардын кичине коллекциясы катары башталган — жаңы баракты ачууга даяр адамдар үчүн кийим, бут кийим жана толуктоочу буюмдар. Ар бир товарды биз өзүбүзгө тандагандай тандайбыз: узакка бериле турган, тез эле жагып калган жана ага татыктуу.",
      renewalTitle: "Жаңылануу", renewalBody: "Ар бир коллекция — жаңы башталыш: эч нерсе адат боюнча текчеде калбайт.",
      qualityTitle: "Сапат", qualityBody: "Ар бир буюмду сизге жеткенге чейин колдо текшеребиз.",
      craftTitle: "Чеберчилик", craftBody: "Кичине партиялар, чеберлер менен жакын мамиле, эч кандай жеңилдетүү жок.",
      getInTouch: "Биз менен байланышыңыз", loveToHear: "Билдирүүңүздү угууга кубанычтабыз",
      emailLabel: "Email", phoneLabel: "Телефон", showroomLabel: "Шоурум", hoursLabel: "Иш убактысы",
      hoursValue: "Дүй–Ишм, 10:00–19:00", showroomValue: "Ош, Кыргызстан", formName: "Аты", formEmail: "Email", formMessage: "Билдирүү",
      formNamePlaceholder: "Атыңыз", formMessagePlaceholder: "Сизге кандай жардам бере алабыз?", send: "Билдирүү жөнөтүү", sent: "Билдирүү жөнөтүлдү ✓",
    },
    adminLogin: {
      setupTitle: "Админ кирүүсүн орнотуу", loginTitle: "Дүкөн ээси үчүн кирүү",
      setupSub: "Phoenix каталогун башкаруу үчүн сырсөз түзүңүз. Аны билген ар ким каталогду өзгөртө алат, андыктан аны купуя сактаңыз.",
      loginSub: "Бул бөлүмгө кирүү бир гана дүкөн ээси үчүн.",
      errShort: "Сырсөз кеминде 6 белгиден турушу керек.", errMatch: "Сырсөздөр дал келген жок.", errWrong: "Сырсөз туура эмес. Кайра аракет кылыңыз.",
      password: "Сырсөз", confirmPassword: "Сырсөздү ырастаңыз", createPassword: "Сырсөз түзүү", logIn: "Кирүү", backHome: "Phoenix'ke кайтуу",
    },
    productForm: {
      image: "Товардын сүрөтү", changeImage: "Сүрөттү алмаштыруу", uploadImage: "Сүрөт жүктөө",
      noImageNote: "Сүрөт жокпу? Биз автоматтык түрдө жасайбыз.",
      nameLabel: "Товардын аты", namePlaceholder: "Мисалы, миди көйнөк",
      priceLabel: "Баасы (KGS)", categoryLabel: "Категория", descriptionLabel: "Сүрөттөмө",
      descriptionPlaceholder: "Кардар билиши керек болгон кемтик, кездеме жана деталдарды сүрөттөңүз.",
      stockLabel: "Кампадагы калдык", lowStockLabel: "Аз калды деп эсептелген чек",
      errName: "Товардын атын жазыңыз.", errPrice: "0дон чоң баа киргизиңиз.", errCategory: "Категорияны тандаңыз.",
      errStock: "Калдыкты көрсөтүңүз (0 же андан көп).",
      errImage: "Сүрөттү окуу мүмкүн болбоду — башка файлды колдонуп көрүңүз.",
      update: "Товарды жаңыртуу", addProduct: "Товар кошуу", cancel: "Жокко чыгаруу",
      langTabHint: "Атын жана сүрөттөмөсүн ар бир тилде толтуруңуз.",
    },
    admin: {
      title: "Phoenix'ти башкаруу", subtitle: "Ээсинин панели", logout: "Чыгуу",
      tabOverview: "Жалпы көрүнүш", tabProducts: "Товарлар", tabOrders: "Буйрутмалар", tabInventory: "Кампа", tabCoupons: "Промокоддор",
      tabAnalytics: "Аналитика", tabAdd: "Товар кошуу", tabSettings: "Жөндөөлөр",
      statTotalProducts: "Товарлар саны", statInventoryValue: "Кампанын наркы", statRevenue: "Киреше",
      statOrders: "Буйрутмалар", statAvgOrder: "Орточо чек", statLowStock: "Аз калгандар",
      lowStockHeading: "Кампада аз калгандар", outOfStockHeading: "Сатылып бүткөндөр",
      topProductsHeading: "Мыкты сатылгандар", noSalesYet: "Азырынча сатуу жок.",
      searchInventory: "Товарлардан издөө…", noProductsTitle: "Товар табылган жок", noProductsBody: "Сурооңузду өзгөртүңүз же биринчи товарды кошуңуз.",
      colProduct: "Товар", colCategory: "Категория", colPrice: "Баасы", colStock: "Калдык", colAdded: "Кошулган күн",
      confirmDeleteProductTitle: "Бул товарды өчүрөсүзбү?", confirmDeleteProductBody: "«{name}» каталогдон кайтарылгыс өчүрүлөт.",
      ordersEmptyTitle: "Буйрутмалар азырынча жок", ordersEmptyBody: "Кардарлардын буйрутмалары бул жерде көрүнөт.",
      allStatuses: "Бардык статустар",
      colOrder: "Буйрутма", colCustomer: "Кардар", colDate: "Күнү", colItems: "Товарлар", colTotal: "Сумма", colStatus: "Абалы", colPayment: "Төлөм",
      status: { pending: "Күтүлүүдө", processing: "Иштелип жатат", shipped: "Жөнөтүлдү", delivered: "Жеткирилди", cancelled: "Жокко чыгарылды" },
      orderDetailCustomer: "Кардар", orderDetailDelivery: "Жеткирүү", orderDetailNote: "Эскертүү", orderDetailNoNote: "Эскертүү жок",
      orderDetailCoupon: "Промокод", orderDetailItems: "Буйрутманын мазмуну",
      couponsEmptyTitle: "Промокоддор азырынча жок", couponsEmptyBody: "Кардарлар үчүн биринчи промокодду түзүңүз.",
      addCoupon: "Промокод кошуу", editCoupon: "Промокодду оңдоо",
      colCode: "Код", colType: "Түрү", colValue: "Мааниси", colExpires: "Мөөнөтү", colUses: "Колдонулган", colActiveState: "Абалы",
      typePercentage: "Пайыз", typeFixed: "Так сумма",
      couponCodeLabel: "Промокод коду", couponCodePlaceholder: "SUMMER10", couponTypeLabel: "Арзандатуу түрү",
      couponValueLabel: "Мааниси", couponMinOrderLabel: "Мин. тапшырык суммасы", couponExpiryLabel: "Мөөнөтү (милдеттүү эмес)",
      couponLimitLabel: "Колдонуу лимити (милдеттүү эмес)", couponActiveLabel: "Промокод иштейт",
      confirmDeleteCouponTitle: "Бул промокодду өчүрөсүзбү?", confirmDeleteCouponBody: "«{code}» коду мындан ары колдонулбайт.",
      settingsPasswordHeading: "Админ сырсөзүн алмаштыруу", currentPassword: "Учурдагы сырсөз", newPassword: "Жаңы сырсөз", confirmNewPassword: "Жаңы сырсөздү ырастаңыз",
      updatePassword: "Сырсөздү жаңыртуу", errCurrentWrong: "Учурдагы сырсөз туура эмес.", errNewShort: "Жаңы сырсөз кеминде 6 белгиден турушу керек.",
      errNewMatch: "Жаңы сырсөздөр дал келген жок.", passwordUpdated: "Сырсөз жаңыртылды.",
      settingsStoreHeading: "Дүкөн жөндөөлөрү", defaultLanguage: "Демейки тил", defaultCurrency: "Демейки валюта",
      exchangeRateLabel: "Алмашуу курсу (1 KGS = ? RUB)", exchangeRateHint: "Азырынча кол менен коюлат; реалдуу убакыттагы курска кошулууга даяр архитектура.",
      saveSettings: "Жөндөөлөрдү сактоо", settingsSaved: "Жөндөөлөр сакталды.",
    },
    inventory: {
      title: "Кампаны башкаруу", subtitle: "Калдыктарды көзөмөлдөп, өз убагында толуктаңыз.",
      lowStockAlert: "Товарлар аяктап баратат", outOfStockAlert: "Сатылып бүткөндөр", allGood: "Калган товарлар жетиштүү санда.",
      colProduct: "Товар", colStock: "Калдык", colThreshold: "Чек", colStatus: "Абалы", colActions: "Аракеттер",
      statusOk: "Бар", statusLow: "Аз калды", statusOut: "Жок",
      increase: "Кошуу", decrease: "Азайтуу", stockUpdated: "Калдык жаңыртылды",
    },
    analytics: {
      title: "Аналитика", subtitle: "Сакталган буйрутмалар жана товарлар боюнча дүкөндүн көрсөткүчтөрү.",
      totalProducts: "Товарлар саны", totalOrders: "Буйрутмалар саны", revenue: "Киреше", lowStockItems: "Кампада аз калгандар",
      ordersByStatus: "Абалы боюнча буйрутмалар", revenueByCategory: "Категория боюнча киреше", noData: "Азырынча маалымат жетишсиз.",
    },
    footer: {
      tagline: "Ош, Кыргызстандан ойлонулган кийим, бут кийим жана толуктоочу буюмдар.",
      emailPlaceholder: "Email дарегиңиз", join: "Жазылуу", joined: "Даяр ✓",
      shopHeading: "Каталог", allProducts: "Бардык товарлар", companyHeading: "Компания",
      aboutUs: "Биз жөнүндө", contact: "Байланыш", storeOwner: "Дүкөн ээси",
      visitUs: "Бизге келиңиз", locationValue: "Ош, Кыргызстан", hours: "Дүй–Ишм, 10:00–19:00", rights: "Бардык укуктар корголгон.", craftedIn: "Ош шаарында сүйүү менен жасалган.",
    },
  },
};

function tPath(dict, path) {
  return path.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), dict);
}

function interpolate(str, vars) {
  if (!vars || typeof str !== "string") return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

const I18nContext = createContext(null);

function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nContext.Provider");
  return ctx;
}

/* =========================================================================
   GLOBAL STYLES
   ========================================================================= */

function GlobalStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,900;1,9..144,500;1,9..144,600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap');

      .phx-root, .phx-root * { box-sizing: border-box; }
      .phx-root {
        --coral: #FF6B4A;
        --coral-dark: #E24E31;
        --coral-tint: #FFE4DB;
        --teal: #0E4F52;
        --teal-deep: #082F31;
        --teal-light: #1C8286;
        --teal-tint: #E4F3F2;
        --gold: #DFA23B;
        --gold-light: #F3C868;
        --cream: #FEFCF8;
        --mist: #F1F6F5;
        --ink: #1C2321;
        --ink-soft: #5B6664;
        --white: #FFFFFF;
        --line: #E4E1D8;
        --shadow-sm: 0 2px 10px rgba(14,45,47,0.06);
        --shadow: 0 14px 34px rgba(14,45,47,0.12);
        --shadow-lg: 0 24px 60px rgba(14,45,47,0.18);
        --radius-sm: 10px;
        --radius: 18px;
        --radius-lg: 28px;
        font-family: 'Plus Jakarta Sans', sans-serif;
        color: var(--ink);
        background: var(--cream);
        min-height: 100vh;
        position: relative;
        line-height: 1.5;
      }
      .phx-root h1, .phx-root h2, .phx-root h3, .phx-root h4 {
        font-family: 'Fraunces', serif;
        font-weight: 600;
        line-height: 1.12;
        margin: 0;
        letter-spacing: -0.01em;
      }
      .phx-root em { font-style: italic; color: var(--coral); font-family: 'Fraunces', serif; }
      .phx-root p { margin: 0; color: var(--ink-soft); }
      .phx-root a { color: inherit; text-decoration: none; }
      .phx-root button { font-family: inherit; cursor: pointer; }
      .phx-root input, .phx-root textarea, .phx-root select { font-family: inherit; }
      .phx-root ul { margin: 0; padding: 0; list-style: none; }
      .phx-root img { max-width: 100%; display: block; }
      .phx-root :focus-visible { outline: 2px solid var(--coral); outline-offset: 2px; border-radius: 4px; }

      .phx-eyebrow {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--coral-dark);
      }
      .phx-price {
        font-family: 'Space Grotesk', sans-serif;
        font-weight: 600;
      }

      .phx-container { max-width: 1180px; margin: 0 auto; padding: 0 24px; }
      .phx-section { padding: 72px 0; }
      @media (max-width: 720px) { .phx-section { padding: 48px 0; } .phx-container { padding: 0 18px; } }

      /* ---------- buttons ---------- */
      .phx-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        border: none; border-radius: 100px; padding: 14px 26px;
        font-weight: 600; font-size: 14.5px; letter-spacing: 0.01em;
        transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease, color 0.18s ease;
        white-space: nowrap;
      }
      .phx-btn:active { transform: scale(0.97); }
      .phx-btn-primary { background: var(--coral); color: white; box-shadow: 0 10px 24px rgba(255,107,74,0.32); }
      .phx-btn-primary:hover { background: var(--coral-dark); box-shadow: 0 14px 30px rgba(255,107,74,0.4); transform: translateY(-1px); }
      .phx-btn-primary:disabled { opacity: 0.5; box-shadow: none; cursor: not-allowed; transform:none; }
      .phx-btn-dark { background: var(--teal-deep); color: white; }
      .phx-btn-dark:hover { background: var(--teal); transform: translateY(-1px); }
      .phx-btn-outline { background: transparent; color: var(--teal-deep); border: 1.5px solid var(--line); }
      .phx-btn-outline:hover { border-color: var(--teal-deep); background: var(--mist); }
      .phx-btn-ghost { background: transparent; color: var(--ink); padding: 10px 16px; }
      .phx-btn-ghost:hover { background: var(--mist); }
      .phx-btn-danger { background: transparent; color: #C4432B; border: 1.5px solid #F1CCC2; }
      .phx-btn-danger:hover { background: #FFF2EE; }
      .phx-btn-sm { padding: 9px 16px; font-size: 13px; }
      .phx-btn-block { width: 100%; }
      .phx-icon-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 42px; height: 42px; border-radius: 50%; border: none;
        background: transparent; color: var(--ink); position: relative;
        transition: background 0.18s ease;
      }
      .phx-icon-btn:hover { background: var(--mist); }

      /* ---------- header ---------- */
      .phx-header {
        position: sticky; top: 0; z-index: 60;
        background: rgba(254,252,248,0.86); backdrop-filter: blur(10px);
        border-bottom: 1px solid transparent;
        transition: border-color 0.25s ease, box-shadow 0.25s ease;
      }
      .phx-header.is-scrolled { border-color: var(--line); box-shadow: 0 4px 18px rgba(14,45,47,0.05); }
      .phx-header-inner { display: flex; align-items: center; justify-content: space-between; height: 78px; gap: 20px; }
      .phx-logo { display: flex; align-items: center; gap: 10px; }
      .phx-logo-word { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 20px; letter-spacing: 0.02em; line-height: 1; color: var(--teal-deep); }
      .phx-logo-tag { font-family: 'Space Grotesk', sans-serif; font-size: 9px; letter-spacing: 0.24em; color: var(--coral-dark); text-transform: uppercase; display:block; margin-top:2px; }
      .phx-nav { display: flex; align-items: center; gap: 6px; }
      .phx-nav-link {
        font-size: 14.5px; font-weight: 600; color: var(--ink-soft); padding: 10px 16px;
        border-radius: 100px; transition: background 0.18s ease, color 0.18s ease;
      }
      .phx-nav-link:hover { background: var(--mist); color: var(--ink); }
      .phx-nav-link.is-active { color: var(--teal-deep); background: var(--teal-tint); }
      .phx-header-actions { display: flex; align-items: center; gap: 4px; }
      .phx-cart-badge {
        position: absolute; top: 2px; right: 2px; min-width: 18px; height: 18px; padding: 0 4px;
        border-radius: 100px; background: var(--coral); color: white; font-size: 10.5px; font-weight: 700;
        display: flex; align-items: center; justify-content: center; font-family: 'Space Grotesk', sans-serif;
      }
      .phx-hamburger { display: none; }
      @media (max-width: 880px) {
        .phx-nav { display: none; }
        .phx-hamburger { display: inline-flex; }
      }
      .phx-mobile-menu {
        position: fixed; inset: 78px 0 0 0; background: var(--cream); z-index: 70;
        padding: 20px; overflow-y: auto; animation: phxSlideDown 0.22s ease;
      }
      .phx-mobile-menu a, .phx-mobile-menu button.phx-mobile-link {
        display: block; width: 100%; text-align: left; background: none; border: none;
        font-family: 'Fraunces', serif; font-size: 28px; padding: 16px 4px; border-bottom: 1px solid var(--line); color: var(--ink);
      }

      /* ---------- locale / currency switcher ---------- */
      .phx-locale-switch { display: flex; align-items: center; gap: 8px; }
      .phx-locale-switch.is-compact { gap: 6px; }
      .phx-dropdown-wrapper { position: relative; }
      .phx-locale-button {
        display: inline-flex; align-items: center; gap: 6px;
        height: 34px; padding: 0 12px 0 11px; border: 1px solid transparent;
        border-radius: 999px; background: var(--mist); color: var(--ink);
        font-family: 'Space Grotesk', sans-serif; font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em;
        appearance: none; -webkit-appearance: none; -moz-appearance: none;
        transition: background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, transform 0.15s ease;
      }
      .phx-locale-button:hover { background: var(--teal-tint); border-color: var(--line); }
      .phx-locale-button:active { transform: scale(0.97); }
      .phx-locale-button.is-open { background: var(--teal-tint); border-color: var(--teal-light); box-shadow: 0 6px 16px rgba(14,45,47,0.12); }
      .phx-locale-button .phx-locale-icon { color: var(--teal-light); flex-shrink: 0; }
      .phx-locale-button .phx-locale-value { min-width: 22px; text-align: center; }
      .phx-locale-chevron { color: var(--ink-soft); flex-shrink: 0; transition: transform 0.2s ease; }
      .phx-locale-button.is-open .phx-locale-chevron { transform: rotate(180deg); }
      .phx-dropdown-menu {
        position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%);
        min-width: 116px; padding: 6px; z-index: 65;
        background: rgba(254,252,248,0.9); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(228,225,216,0.7); border-radius: 12px; box-shadow: var(--shadow-lg);
        animation: phxDropIn 0.18s ease;
      }
      .phx-dropdown-item {
        display: flex; align-items: center; justify-content: space-between; gap: 14px;
        width: 100%; padding: 9px 11px; border: none; background: transparent; border-radius: 8px;
        font-family: 'Space Grotesk', sans-serif; font-size: 13px; font-weight: 600; color: var(--ink);
        text-align: left; transition: background 0.15s ease, color 0.15s ease;
      }
      .phx-dropdown-item + .phx-dropdown-item { margin-top: 2px; }
      .phx-dropdown-item:hover { background: var(--mist); }
      .phx-dropdown-item.active { background: var(--teal-tint); color: var(--teal-deep); }
      .phx-dropdown-item.active svg { color: var(--coral); }
      @keyframes phxDropIn {
        from { opacity: 0; transform: translateX(-50%) translateY(-6px) scale(0.96); }
        to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
      }

      /* ---------- search overlay ---------- */
      .phx-search-overlay {
        position: fixed; inset: 0; background: rgba(9,30,31,0.55); z-index: 80;
        display: flex; align-items: flex-start; justify-content: center; padding: 90px 20px;
        animation: phxFadeIn 0.18s ease;
      }
      .phx-search-box { width: 100%; max-width: 620px; background: white; border-radius: var(--radius); box-shadow: var(--shadow-lg); padding: 8px; animation: phxPopIn 0.22s ease; }
      .phx-search-box input {
        width: 100%; border: none; outline: none; font-size: 20px; padding: 16px 18px;
        font-family: 'Fraunces', serif; background: transparent;
      }
      .phx-search-row { display: flex; align-items: center; gap: 10px; }

      /* ---------- hero ---------- */
      .phx-hero { padding: 56px 0 24px; overflow: hidden; }
      .phx-hero-grid { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 56px; align-items: center; }
      @media (max-width: 900px) { .phx-hero-grid { grid-template-columns: 1fr; gap: 40px; } }
      .phx-hero h1 { font-size: clamp(38px, 5.4vw, 64px); margin: 14px 0 20px; }
      .phx-hero p.lead { font-size: 17px; max-width: 460px; margin-bottom: 30px; }
      .phx-hero-ctas { display: flex; gap: 14px; flex-wrap: wrap; }
      .phx-hero-visual { position: relative; }
      .phx-hero-card {
        position: relative; border-radius: var(--radius-lg); overflow: hidden; aspect-ratio: 4/5;
        box-shadow: var(--shadow-lg); background: var(--teal-tint);
      }
      .phx-hero-card img { width: 100%; height: 100%; object-fit: cover; }
      .phx-hero-ribbon {
        position: absolute; top: 18px; left: 18px; background: var(--teal-deep); color: white;
        font-family: 'Space Grotesk', sans-serif; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
        padding: 8px 14px; border-radius: 100px; display:flex; align-items:center; gap:6px;
      }
      .phx-hero-tag {
        position: absolute; bottom: -14px; right: 20px; background: white; border-radius: 16px;
        padding: 14px 20px; box-shadow: var(--shadow-lg); transform: rotate(-3deg);
      }
      .phx-hero-tag .phx-price { font-size: 22px; color: var(--coral-dark); }
      .phx-hero-tag .name { font-size: 12.5px; color: var(--ink-soft); margin-top: 2px; max-width: 160px; }
      .phx-hero-watermark { position: absolute; opacity: 0.08; pointer-events: none; }

      /* ---------- category strip ---------- */
      .phx-cat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
      @media (max-width: 720px) { .phx-cat-grid { grid-template-columns: 1fr; } }
      .phx-cat-card {
        display: flex; align-items: center; gap: 16px; padding: 22px 24px; border-radius: var(--radius);
        background: white; border: 1px solid var(--line); transition: all 0.2s ease; text-align: left;
      }
      .phx-cat-card:hover { transform: translateY(-3px); box-shadow: var(--shadow); border-color: transparent; }
      .phx-cat-icon { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink:0; }
      .phx-cat-card h3 { font-size: 19px; }
      .phx-cat-card p { font-size: 13px; margin-top: 2px; }

      /* ---------- product grid & card ---------- */
      .phx-product-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 22px; }
      @media (max-width: 1020px) { .phx-product-grid { grid-template-columns: repeat(3, 1fr); } }
      @media (max-width: 720px) { .phx-product-grid { grid-template-columns: repeat(2, 1fr); gap: 14px; } }
      @media (max-width: 460px) { .phx-product-grid { grid-template-columns: 1fr 1fr; } }

      .product-card { cursor: pointer; animation: phxFadeUp 0.4s ease both; }
      .product-card-media {
        position: relative; border-radius: var(--radius); overflow: hidden; aspect-ratio: 1/1.08;
        background: var(--mist); box-shadow: var(--shadow-sm); transition: box-shadow 0.25s ease;
      }
      .product-card:hover .product-card-media { box-shadow: var(--shadow); }
      .product-card-media img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.4s ease; }
      .product-card:hover .product-card-media img { transform: scale(1.06); }
      .product-card-badge {
        position: absolute; top: 10px; left: 10px; background: rgba(255,255,255,0.92);
        color: var(--ink); font-size: 10.5px; font-weight: 700; letter-spacing: 0.03em;
        padding: 5px 10px; border-radius: 100px; display: flex; align-items: center; gap: 4px;
      }
      .product-card-badge svg { color: var(--badge-color, var(--coral)); }
      .product-card-quickadd {
        position: absolute; bottom: 10px; right: 10px; width: 38px; height: 38px; border-radius: 50%;
        background: var(--teal-deep); color: white; border: none; display: flex; align-items: center; justify-content: center;
        opacity: 0; transform: translateY(6px); transition: all 0.2s ease; box-shadow: var(--shadow-sm);
      }
      .product-card:hover .product-card-quickadd { opacity: 1; transform: translateY(0); }
      .product-card-quickadd:hover { background: var(--coral); }
      .product-card-body { padding: 12px 2px 0; }
      .product-card-body h3 { font-size: 15.5px; font-weight: 600; font-family: 'Plus Jakarta Sans', sans-serif; color: var(--ink); }
      .product-card-body .price { margin-top: 4px; font-size: 15px; color: var(--coral-dark); }

      /* ---------- value band ---------- */
      .phx-value-band { background: var(--teal-deep); color: white; border-radius: var(--radius-lg); padding: 44px 40px; }
      .phx-value-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 30px; }
      @media (max-width: 720px) { .phx-value-grid { grid-template-columns: 1fr; } .phx-value-band { padding: 32px 24px; } }
      .phx-value-item h4 { color: white; font-size: 18px; margin-bottom: 6px; }
      .phx-value-item p { color: rgba(255,255,255,0.66); font-size: 14px; }
      .phx-value-item svg { color: var(--gold-light); margin-bottom: 12px; }

      /* ---------- CTA band ---------- */
      .phx-cta-band {
        text-align: center; padding: 64px 24px; border-radius: var(--radius-lg);
        background: linear-gradient(135deg, var(--coral-tint), var(--teal-tint));
        position: relative; overflow: hidden;
      }
      .phx-cta-band h2 { font-size: clamp(28px, 4vw, 42px); margin-bottom: 18px; }

      /* ---------- footer ---------- */
      .phx-footer { background: var(--teal-deep); color: rgba(255,255,255,0.72); padding: 64px 0 28px; margin-top: 40px; }
      .phx-footer-grid { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1.3fr; gap: 40px; }
      @media (max-width: 820px) { .phx-footer-grid { grid-template-columns: 1fr 1fr; } }
      @media (max-width: 520px) { .phx-footer-grid { grid-template-columns: 1fr; } }
      .phx-footer h5 { color: white; font-family: 'Space Grotesk', sans-serif; font-size: 12.5px; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 16px; }
      .phx-footer ul li { margin-bottom: 10px; }
      .phx-footer a:hover { color: white; }
      .phx-footer-bottom { border-top: 1px solid rgba(255,255,255,0.14); margin-top: 40px; padding-top: 22px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; font-size: 12.5px; }
      .phx-newsletter { display: flex; gap: 8px; margin-top: 6px; }
      .phx-newsletter input { flex: 1; min-width: 0; padding: 11px 14px; border-radius: 100px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.06); color: white; font-size: 13.5px; }
      .phx-newsletter input::placeholder { color: rgba(255,255,255,0.45); }
      .phx-newsletter button { border-radius: 100px; background: var(--coral); color: white; border: none; padding: 0 18px; font-weight: 600; font-size: 13px; }

      /* ---------- page header ---------- */
      .phx-page-head { padding: 40px 0 30px; border-bottom: 1px solid var(--line); }
      .phx-breadcrumb { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-soft); margin-bottom: 14px; flex-wrap: wrap; }
      .phx-breadcrumb a:hover { color: var(--coral-dark); }
      .phx-page-head h1 { font-size: clamp(30px, 4vw, 44px); }

      /* ---------- catalog layout ---------- */
      .phx-catalog-layout { display: grid; grid-template-columns: 250px 1fr; gap: 40px; align-items: start; padding-top: 34px; }
      @media (max-width: 880px) { .phx-catalog-layout { grid-template-columns: 1fr; } }
      .phx-filters { position: sticky; top: 96px; }
      @media (max-width: 880px) { .phx-filters { position: static; } }
      .phx-filter-block { margin-bottom: 28px; }
      .phx-filter-block h4 { font-size: 12.5px; letter-spacing: 0.08em; text-transform: uppercase; font-family: 'Space Grotesk', sans-serif; color: var(--ink); margin-bottom: 14px; }
      .phx-cat-check { display: flex; align-items: center; gap: 10px; padding: 8px 0; font-size: 14.5px; color: var(--ink-soft); }
      .phx-cat-check.is-active { color: var(--ink); font-weight: 700; }
      .phx-checkbox { width: 18px; height: 18px; border-radius: 6px; border: 1.5px solid var(--line); display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.15s ease; }
      .phx-checkbox.is-checked { background: var(--coral); border-color: var(--coral); color: white; }
      .phx-clear-filters { font-size: 13px; color: var(--coral-dark); font-weight: 600; }
      .phx-results-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22px; gap: 14px; flex-wrap: wrap; }
      .phx-results-count { font-size: 14px; color: var(--ink-soft); }
      .phx-sort-select { border: 1.5px solid var(--line); border-radius: 100px; padding: 9px 34px 9px 16px; font-size: 13.5px; font-weight: 600; background: white; appearance: none; }
      .phx-select-wrap { position: relative; display: inline-flex; align-items: center; }
      .phx-select-wrap svg { position: absolute; right: 12px; pointer-events: none; color: var(--ink-soft); }
      .phx-filter-toggle { display: none; }
      @media (max-width: 880px) { .phx-filter-toggle { display: inline-flex; } }
      .phx-filters-content { display: block; }
      @media (max-width: 880px) {
        .phx-filters-content { display: none; }
        .phx-filters-content.is-open {
          display: block; border: 1px solid var(--line); border-radius: var(--radius);
          padding: 20px; margin-bottom: 20px; background: white; animation: phxSlideDown 0.2s ease;
        }
      }

      /* ---------- price range ---------- */
      .phx-price-range { position: relative; height: 34px; margin-top: 6px; }
      .phx-price-track { position: absolute; top: 15px; left: 2px; right: 2px; height: 4px; background: var(--line); border-radius: 4px; }
      .phx-price-fill { position: absolute; top: 15px; height: 4px; background: var(--coral); border-radius: 4px; }
      .phx-price-range input[type="range"] {
        position: absolute; top: 8px; left: 0; width: 100%; margin: 0; background: none; pointer-events: none;
        -webkit-appearance: none; appearance: none; height: 18px;
      }
      .phx-price-range input[type="range"]::-webkit-slider-thumb {
        pointer-events: auto; -webkit-appearance: none; width: 17px; height: 17px; border-radius: 50%;
        background: var(--coral); border: 3px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.25); cursor: pointer;
      }
      .phx-price-range input[type="range"]::-moz-range-thumb {
        pointer-events: auto; width: 17px; height: 17px; border-radius: 50%; background: var(--coral);
        border: 3px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.25); cursor: pointer;
      }
      .phx-price-range input[type="range"]::-moz-range-track { background: transparent; }
      .phx-price-labels { display: flex; justify-content: space-between; margin-top: 10px; font-size: 13px; font-weight: 600; font-family: 'Space Grotesk', sans-serif; color: var(--ink); }

      /* ---------- empty state ---------- */
      .phx-empty { text-align: center; padding: 70px 20px; }
      .phx-empty svg { color: var(--line); margin-bottom: 16px; }
      .phx-empty h3 { font-size: 22px; margin-bottom: 8px; }
      .phx-empty p { margin-bottom: 22px; }

      /* ---------- product detail ---------- */
      .phx-product-detail { display: grid; grid-template-columns: 1fr 1fr; gap: 56px; padding: 36px 0 70px; align-items: flex-start; }
      @media (max-width: 860px) { .phx-product-detail { grid-template-columns: 1fr; gap: 30px; } }
      .phx-product-image { border-radius: var(--radius-lg); overflow: hidden; aspect-ratio: 1/1; box-shadow: var(--shadow); background: var(--mist); position: sticky; top: 100px; }
      @media (max-width: 860px) { .phx-product-image { position: static; } }
      .phx-product-image img { width: 100%; height: 100%; object-fit: cover; }
      .phx-badge-pill {
        display: inline-flex; align-items: center; gap: 6px; background: var(--mist); color: var(--ink);
        font-size: 12px; font-weight: 700; letter-spacing: 0.03em; padding: 6px 14px; border-radius: 100px; margin-bottom: 16px;
      }
      .phx-product-info h1 { font-size: clamp(28px, 3.6vw, 40px); margin-bottom: 14px; }
      .phx-product-info .phx-price { font-size: 26px; color: var(--coral-dark); display: block; margin-bottom: 22px; }
      .phx-product-info .desc { font-size: 15.5px; line-height: 1.7; margin-bottom: 28px; }
      .phx-qty-row { display: flex; align-items: center; gap: 18px; margin-bottom: 22px; }
      .phx-stepper { display: flex; align-items: center; border: 1.5px solid var(--line); border-radius: 100px; overflow: hidden; }
      .phx-stepper button { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; background: white; border: none; color: var(--ink); }
      .phx-stepper button:hover { background: var(--mist); }
      .phx-stepper span { width: 34px; text-align: center; font-weight: 700; font-family: 'Space Grotesk', sans-serif; }
      .phx-related { margin-top: 8px; }
      .phx-related h3 { font-size: 20px; margin-bottom: 18px; }

      /* ---------- cart ---------- */
      .phx-cart-layout { display: grid; grid-template-columns: 1fr 340px; gap: 40px; padding: 36px 0 70px; align-items: flex-start; }
      @media (max-width: 860px) { .phx-cart-layout { grid-template-columns: 1fr; } }
      .phx-cart-row { display: grid; grid-template-columns: 84px 1fr auto; gap: 16px; align-items: center; padding: 18px 0; border-bottom: 1px solid var(--line); }
      .phx-cart-row img { width: 84px; height: 84px; object-fit: cover; border-radius: 12px; }
      .phx-cart-row h4 { font-size: 15.5px; margin-bottom: 4px; }
      .phx-cart-row .cat { font-size: 12px; color: var(--ink-soft); margin-bottom: 8px; }
      .phx-cart-row-actions { display: flex; align-items: center; gap: 16px; }
      .phx-cart-row .line-total { font-family: 'Space Grotesk', sans-serif; font-weight: 700; min-width: 62px; text-align: right; }
      .phx-summary-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 26px; background: white; position: sticky; top: 100px; }
      .phx-summary-row { display: flex; justify-content: space-between; font-size: 14.5px; margin-bottom: 12px; color: var(--ink-soft); }
      .phx-summary-row.total { color: var(--ink); font-weight: 700; font-size: 17px; padding-top: 14px; margin-top: 4px; border-top: 1px solid var(--line); }
      .phx-summary-row.total .phx-price { color: var(--coral-dark); }

      /* ---------- forms ---------- */
      .phx-field { margin-bottom: 18px; }
      .phx-field label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 7px; color: var(--ink); }
      .phx-field .hint { font-size: 12px; color: var(--ink-soft); font-weight: 400; margin-left: 6px; }
      .phx-input, .phx-textarea, .phx-select {
        width: 100%; border: 1.5px solid var(--line); border-radius: 12px; padding: 12px 14px;
        font-size: 14.5px; background: white; color: var(--ink); transition: border-color 0.15s ease;
      }
      .phx-input:focus, .phx-textarea:focus, .phx-select:focus { border-color: var(--coral); outline: none; }
      .phx-textarea { resize: vertical; min-height: 110px; }
      .phx-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      @media (max-width: 520px) { .phx-field-row { grid-template-columns: 1fr; } }
      .phx-field-error { color: #C4432B; font-size: 12.5px; margin-top: 6px; }
      .phx-input.has-error, .phx-textarea.has-error { border-color: #E48A76; }

      /* ---------- cart drawer ---------- */
      .phx-drawer-backdrop { position: fixed; inset: 0; background: rgba(9,30,31,0.5); z-index: 90; animation: phxFadeIn 0.2s ease; }
      .phx-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); background: var(--cream); z-index: 91; display: flex; flex-direction: column; animation: phxSlideLeft 0.25s ease; box-shadow: -20px 0 50px rgba(0,0,0,0.2); }
      .phx-drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 22px 22px; border-bottom: 1px solid var(--line); }
      .phx-drawer-head h3 { font-size: 20px; }
      .phx-drawer-body { flex: 1; overflow-y: auto; padding: 6px 22px; }
      .phx-drawer-foot { padding: 20px 22px 26px; border-top: 1px solid var(--line); background: white; }
      .phx-drawer-row { display: grid; grid-template-columns: 60px 1fr auto; gap: 12px; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--line); }
      .phx-drawer-row img { width: 60px; height: 60px; border-radius: 10px; object-fit: cover; }
      .phx-drawer-row h5 { font-size: 14px; margin-bottom: 4px; }

      /* ---------- toast ---------- */
      .phx-toast-wrap { position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%); z-index: 120; }
      .phx-toast {
        display: flex; align-items: center; gap: 10px; background: var(--teal-deep); color: white;
        padding: 14px 20px; border-radius: 100px; box-shadow: var(--shadow-lg); font-size: 14px; font-weight: 600;
        animation: phxToastIn 0.3s ease;
      }
      .phx-toast svg { color: var(--gold-light); flex-shrink: 0; }

      /* ---------- about ---------- */
      .phx-about-hero { padding: 50px 0 20px; text-align: center; max-width: 680px; margin: 0 auto; }
      .phx-about-hero h1 { font-size: clamp(32px, 5vw, 52px); margin: 14px 0 18px; }
      .phx-values-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; margin: 50px 0; }
      @media (max-width: 720px) { .phx-values-grid { grid-template-columns: 1fr; } }
      .phx-value-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 28px; background: white; }
      .phx-value-card svg { color: var(--coral); margin-bottom: 14px; }
      .phx-value-card h3 { font-size: 18px; margin-bottom: 8px; }
      .phx-contact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 50px; margin-top: 20px; }
      @media (max-width: 820px) { .phx-contact-grid { grid-template-columns: 1fr; } }
      .phx-contact-info-item { display: flex; gap: 14px; margin-bottom: 22px; }
      .phx-contact-info-item .ic { width: 42px; height: 42px; border-radius: 50%; background: var(--teal-tint); color: var(--teal-deep); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .phx-contact-info-item h4 { font-size: 15px; margin-bottom: 3px; }

      /* ---------- admin ---------- */
      .phx-admin-login-wrap { min-height: calc(100vh - 78px); display: flex; align-items: center; justify-content: center; background: radial-gradient(circle at 20% 20%, var(--teal-light), var(--teal-deep) 60%); padding: 40px 20px; }
      .phx-admin-card { width: 100%; max-width: 400px; background: white; border-radius: var(--radius-lg); padding: 40px 34px; box-shadow: var(--shadow-lg); text-align: center; }
      .phx-admin-card h2 { font-size: 24px; margin: 16px 0 6px; }
      .phx-admin-card .sub { font-size: 13.5px; margin-bottom: 26px; }
      .phx-admin-mark { display: inline-flex; align-items: center; justify-content: center; width: 60px; height: 60px; border-radius: 50%; background: var(--teal-tint); }
      .phx-admin-error { display: flex; align-items: center; gap: 8px; background: #FFF1EE; color: #C4432B; padding: 10px 14px; border-radius: 10px; font-size: 13px; margin-bottom: 16px; text-align: left; }

      .phx-admin-shell { padding: 30px 0 70px; }
      .phx-admin-topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 26px; flex-wrap: wrap; gap: 14px; }
      .phx-admin-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--line); margin-bottom: 26px; flex-wrap: wrap; }
      .phx-admin-tab { display: flex; align-items: center; gap: 8px; padding: 12px 18px; font-weight: 700; font-size: 14px; color: var(--ink-soft); border-bottom: 2px solid transparent; margin-bottom: -1px; }
      .phx-admin-tab.is-active { color: var(--teal-deep); border-color: var(--coral); }
      .phx-admin-tab:hover { color: var(--ink); }

      .phx-admin-table-wrap { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: white; }
      .phx-admin-table { width: 100%; border-collapse: collapse; }
      .phx-admin-table th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); padding: 14px 18px; background: var(--mist); font-family: 'Space Grotesk', sans-serif; }
      .phx-admin-table td { padding: 14px 18px; border-top: 1px solid var(--line); font-size: 14px; vertical-align: middle; }
      .phx-admin-table tr:hover td { background: #FCFAF5; }
      .phx-admin-thumb { width: 46px; height: 46px; border-radius: 10px; object-fit: cover; }
      .phx-admin-cat-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 700; padding: 4px 10px; border-radius: 100px; background: var(--mist); }
      .phx-admin-row-actions { display: flex; gap: 6px; justify-content: flex-end; }
      .phx-table-scroll { overflow-x: auto; }

      .phx-admin-form-card { border: 1px solid var(--line); border-radius: var(--radius); background: white; padding: 30px; max-width: 640px; }
      .phx-image-upload { display: flex; gap: 18px; align-items: center; }
      .phx-image-preview { width: 96px; height: 96px; border-radius: 14px; overflow: hidden; background: var(--mist); flex-shrink: 0; border: 1.5px dashed var(--line); display: flex; align-items: center; justify-content: center; }
      .phx-image-preview img { width: 100%; height: 100%; object-fit: cover; }
      .phx-upload-btn { display: inline-flex; align-items: center; gap: 8px; }

      .phx-stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 26px; }
      @media (max-width: 720px) { .phx-stat-row { grid-template-columns: 1fr 1fr; } }
      .phx-stat-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; background: white; }
      .phx-stat-card .num { font-family: 'Fraunces', serif; font-size: 30px; }
      .phx-stat-card .lbl { font-size: 12.5px; color: var(--ink-soft); margin-top: 4px; }

      /* ---------- confirm dialog ---------- */
      .phx-modal-backdrop { position: fixed; inset: 0; background: rgba(9,30,31,0.55); z-index: 130; display: flex; align-items: center; justify-content: center; padding: 20px; animation: phxFadeIn 0.15s ease; }
      .phx-modal { background: white; border-radius: var(--radius); padding: 28px; max-width: 380px; width: 100%; box-shadow: var(--shadow-lg); animation: phxPopIn 0.2s ease; }
      .phx-modal h3 { font-size: 19px; margin-bottom: 10px; }
      .phx-modal p { font-size: 14px; margin-bottom: 22px; }
      .phx-modal-actions { display: flex; gap: 10px; justify-content: flex-end; }

      /* ---------- checkout ---------- */
      .phx-checkout-layout { display: grid; grid-template-columns: 1fr 360px; gap: 44px; padding: 36px 0 70px; align-items: flex-start; }
      @media (max-width: 900px) { .phx-checkout-layout { grid-template-columns: 1fr; } }
      .phx-mini-row { display: flex; justify-content: space-between; font-size: 13.5px; padding: 8px 0; color: var(--ink-soft); }
      .phx-mini-row span.n { color: var(--ink); font-weight: 600; }
      .phx-confirm-wrap { max-width: 560px; margin: 0 auto; text-align: center; padding: 70px 20px; }
      .phx-confirm-icon { width: 84px; height: 84px; border-radius: 50%; background: var(--teal-tint); display: flex; align-items: center; justify-content: center; margin: 0 auto 22px; color: var(--teal-deep); }
      .phx-confirm-wrap h1 { font-size: 34px; margin-bottom: 10px; }
      .phx-order-id { font-family: 'Space Grotesk', sans-serif; font-weight: 700; letter-spacing: 0.06em; background: var(--mist); display: inline-block; padding: 8px 18px; border-radius: 100px; margin: 16px 0 24px; }
      .phx-confirm-summary { text-align: left; border: 1px solid var(--line); border-radius: var(--radius); padding: 20px 24px; margin: 26px 0; background: white; }

      /* ---------- phoenix mark ---------- */
      .phx-mark-feather { transform-origin: 32px 32px; animation: phxFlicker 3.4s ease-in-out infinite; }
      .phx-mark-feather:nth-child(2) { animation-delay: 0.6s; }

      /* ---------- animations ---------- */
      @keyframes phxFadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes phxFadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes phxPopIn { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: scale(1); } }
      @keyframes phxSlideDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes phxSlideLeft { from { transform: translateX(100%); } to { transform: translateX(0); } }
      @keyframes phxToastIn { from { opacity: 0; transform: translateY(14px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @keyframes phxFlicker { 0%, 100% { opacity: 0.92; transform: scale(1); } 50% { opacity: 1; transform: scale(1.035); } }
      .phx-anim-up { animation: phxFadeUp 0.55s ease both; }
      .phx-anim-up-1 { animation-delay: 0.05s; }
      .phx-anim-up-2 { animation-delay: 0.14s; }
      .phx-anim-up-3 { animation-delay: 0.22s; }

      @media (prefers-reduced-motion: reduce) {
        .phx-root *, .phx-root *::before, .phx-root *::after {
          animation-duration: 0.001ms !important; animation-iteration-count: 1 !important;
          transition-duration: 0.001ms !important; scroll-behavior: auto !important;
        }
      }

      .phx-loading-screen { min-height: 60vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: var(--ink-soft); }
      .phx-spin { animation: phxSpin 0.9s linear infinite; }
      @keyframes phxSpin { to { transform: rotate(360deg); } }
    `}</style>
  );
}

/* =========================================================================
   SMALL COMPONENTS
   ========================================================================= */

function PhoenixMark({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="phxGrad" x1="4" y1="60" x2="60" y2="4">
          <stop offset="0" stopColor="#FF6B4A" />
          <stop offset="0.55" stopColor="#DFA23B" />
          <stop offset="1" stopColor="#F3C868" />
        </linearGradient>
      </defs>
      <path className="phx-mark-feather" d="M32 58C21 51 15 40 18 28c2 7 6 12 11 15-2-10 0-21 9-30-3 11-1 20 5 26 5-5 7-13 4-24 9 9 11 22 4 32 4-2 7-6 9-11-1 13-13 22-28 22Z" fill="url(#phxGrad)" />
      <path className="phx-mark-feather" d="M32 58c-6-4-10-10-10-17 3 4 6 7 10 8-1-7 1-14 6-19-1 7 1 13 5 16 3-3 4-8 2-15 5 6 6 14 1 20 2-1 4-3 5-6-1 8-9 13-19 13Z" fill="white" opacity="0.22" />
    </svg>
  );
}

function PhoenixLogo({ compact = false }) {
  return (
    <span className="phx-logo">
      <PhoenixMark size={compact ? 28 : 34} />
      {!compact && (
        <span>
          <span className="phx-logo-word">PHOENIX</span>
          <span className="phx-logo-tag">Style House</span>
        </span>
      )}
    </span>
  );
}

function CategoryIcon({ category, size = 12 }) {
  const meta = CATEGORY_META[category] || CATEGORY_META.Other;
  const Icon = meta.icon;
  return <Icon size={size} />;
}

function PriceRange({ min, max, value, onChange }) {
  const { formatMoney } = useI18n();
  const [lo, hi] = value;
  const span = Math.max(1, max - min);
  const pctLo = ((lo - min) / span) * 100;
  const pctHi = ((hi - min) / span) * 100;
  return (
    <div className="phx-price-range">
      <div className="phx-price-track" />
      <div className="phx-price-fill" style={{ left: `${pctLo}%`, width: `${Math.max(0, pctHi - pctLo)}%` }} />
      <input
        type="range" min={min} max={max} value={lo}
        onChange={(e) => onChange([Math.min(Number(e.target.value), hi - 1 < min ? min : hi - 1), hi])}
      />
      <input
        type="range" min={min} max={max} value={hi}
        onChange={(e) => onChange([lo, Math.max(Number(e.target.value), lo + 1 > max ? max : lo + 1)])}
      />
      <div className="phx-price-labels"><span>{formatMoney(lo)}</span><span>{formatMoney(hi)}</span></div>
    </div>
  );
}

function ProductCard({ product, index = 0, onSelect, onQuickAdd }) {
  const { t, lang, formatMoney } = useI18n();
  const meta = CATEGORY_META[product.category] || CATEGORY_META.Other;
  const name = L(product.name, lang);
  const outOfStock = Number(product.stock) <= 0;
  return (
    <article className="product-card" style={{ animationDelay: `${Math.min(index, 8) * 0.05}s` }} onClick={() => onSelect(product.id)}>
      <div className="product-card-media">
        <img src={product.image} alt={name} loading="lazy" style={outOfStock ? { opacity: 0.55 } : undefined} />
        <span className="product-card-badge" style={{ "--badge-color": meta.color }}>
          <CategoryIcon category={product.category} /> {t(`category.${product.category}`)}
        </span>
        {outOfStock ? (
          <span className="product-card-badge" style={{ left: "auto", right: 10, top: 10, background: "rgba(28,35,33,0.82)", color: "white" }}>
            {t("product.outOfStock")}
          </span>
        ) : (
          <button className="product-card-quickadd" onClick={(e) => { e.stopPropagation(); onQuickAdd(product); }} aria-label={`${t("product.addToBag")}: ${name}`}>
            <Plus size={17} />
          </button>
        )}
      </div>
      <div className="product-card-body">
        <h3>{name}</h3>
        <p className="price phx-price">{formatMoney(product.price)}</p>
      </div>
    </article>
  );
}

function EmptyState({ icon: Icon = Search, title, body, actionLabel, onAction }) {
  return (
    <div className="phx-empty">
      <Icon size={46} strokeWidth={1.4} />
      <h3>{title}</h3>
      <p>{body}</p>
      {actionLabel && (
        <button className="phx-btn phx-btn-primary" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel }) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <div className="phx-modal-backdrop" onClick={onCancel}>
      <div className="phx-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="phx-modal-actions">
          <button className="phx-btn phx-btn-outline phx-btn-sm" onClick={onCancel}>{t("common.cancel")}</button>
          <button className="phx-btn phx-btn-danger phx-btn-sm" style={{ background: "#C4432B", color: "white", border: "none" }} onClick={onConfirm}>{confirmLabel || t("common.delete")}</button>
        </div>
      </div>
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className="phx-toast-wrap">
      <div className="phx-toast" key={toast.id}>
        <Check size={16} /> {toast.message}
      </div>
    </div>
  );
}

/* =========================================================================
   HEADER / NAV
   ========================================================================= */

function LangCurrencySwitcher({ compact = false }) {
  const { t, lang, setLang, currency, setCurrency } = useI18n();
  const [openLanguage, setOpenLanguage] = useState(false);
  const [openCurrency, setOpenCurrency] = useState(false);
  const langRef = useRef(null);
  const currencyRef = useRef(null);

  useEffect(() => {
    if (!openLanguage && !openCurrency) return;
    const onPointerDown = (e) => {
      if (langRef.current && !langRef.current.contains(e.target)) setOpenLanguage(false);
      if (currencyRef.current && !currencyRef.current.contains(e.target)) setOpenCurrency(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") { setOpenLanguage(false); setOpenCurrency(false); }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openLanguage, openCurrency]);

  const activeLanguage = LANGUAGES.find((l) => l.code === lang) || LANGUAGES[0];
  const activeCurrency = CURRENCIES.find((c) => c.code === currency) || CURRENCIES[0];

  const pickLanguage = (code) => { setLang(code); setOpenLanguage(false); };
  const pickCurrency = (code) => { setCurrency(code); setOpenCurrency(false); };

  return (
    <div className={`phx-locale-switch ${compact ? "is-compact" : ""}`}>
      <div className="phx-dropdown-wrapper" ref={langRef}>
        <button
          type="button"
          className={`phx-locale-button ${openLanguage ? "is-open" : ""}`}
          aria-label={t("common.language")}
          aria-haspopup="listbox"
          aria-expanded={openLanguage}
          onClick={() => { setOpenLanguage((v) => !v); setOpenCurrency(false); }}
        >
          <Globe size={13} className="phx-locale-icon" />
          <span className="phx-locale-value">{activeLanguage.short}</span>
          <ChevronDown size={13} className="phx-locale-chevron" />
        </button>
        {openLanguage && (
          <div className="phx-dropdown-menu" role="listbox" aria-label={t("common.language")}>
            {LANGUAGES.map((l) => (
              <button
                type="button"
                key={l.code}
                role="option"
                aria-selected={l.code === lang}
                className={`phx-dropdown-item ${l.code === lang ? "active" : ""}`}
                onClick={() => pickLanguage(l.code)}
              >
                <span>{l.short}</span>
                {l.code === lang && <Check size={14} />}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="phx-dropdown-wrapper" ref={currencyRef}>
        <button
          type="button"
          className={`phx-locale-button ${openCurrency ? "is-open" : ""}`}
          aria-label={t("common.currency")}
          aria-haspopup="listbox"
          aria-expanded={openCurrency}
          onClick={() => { setOpenCurrency((v) => !v); setOpenLanguage(false); }}
        >
          <Coins size={13} className="phx-locale-icon" />
          <span className="phx-locale-value">{activeCurrency.code}</span>
          <ChevronDown size={13} className="phx-locale-chevron" />
        </button>
        {openCurrency && (
          <div className="phx-dropdown-menu" role="listbox" aria-label={t("common.currency")}>
            {CURRENCIES.map((c) => (
              <button
                type="button"
                key={c.code}
                role="option"
                aria-selected={c.code === currency}
                className={`phx-dropdown-item ${c.code === currency ? "active" : ""}`}
                onClick={() => pickCurrency(c.code)}
              >
                <span>{c.code}</span>
                {c.code === currency && <Check size={14} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Header({ page, cartCount, isAdmin, onNavigate, onOpenCart, onOpenSearch }) {
  const { t } = useI18n();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const links = [
    { key: "home", label: t("nav.home") },
    { key: "catalog", label: t("nav.shop") },
    { key: "about", label: t("nav.about") },
  ];

  const go = (key) => { setMenuOpen(false); onNavigate(key); };

  return (
    <header className={`phx-header ${scrolled ? "is-scrolled" : ""}`}>
      <div className="phx-container phx-header-inner">
        <a href="#" onClick={(e) => { e.preventDefault(); go("home"); }}>
          <PhoenixLogo />
        </a>
        <nav className="phx-nav">
          {links.map((l) => (
            <a key={l.key} href="#" className={`phx-nav-link ${page === l.key ? "is-active" : ""}`}
              onClick={(e) => { e.preventDefault(); go(l.key); }}>{l.label}</a>
          ))}
        </nav>
        <div className="phx-header-actions">
          <LangCurrencySwitcher compact />
          <button className="phx-icon-btn" aria-label={t("header.searchAria")} onClick={onOpenSearch}><Search size={19} /></button>
          <button className="phx-icon-btn" aria-label={t("header.cartAria")} onClick={onOpenCart}>
            <ShoppingBag size={19} />
            {cartCount > 0 && <span className="phx-cart-badge">{cartCount}</span>}
          </button>
          <button className="phx-icon-btn" aria-label={t("header.ownerAria")} onClick={() => go(isAdmin ? "admin-dashboard" : "admin-login")}>
            <Lock size={18} />
          </button>
          <button className="phx-icon-btn phx-hamburger" aria-label={t("header.menuAria")} onClick={() => setMenuOpen((v) => !v)}>
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
      {menuOpen && (
        <div className="phx-mobile-menu">
          {links.map((l) => (
            <a key={l.key} href="#" onClick={(e) => { e.preventDefault(); go(l.key); }}>{l.label}</a>
          ))}
          <button className="phx-mobile-link" onClick={() => go(isAdmin ? "admin-dashboard" : "admin-login")}>
            {isAdmin ? t("nav.adminDashboard") : t("nav.storeOwner")}
          </button>
          <div style={{ padding: "16px 4px" }}><LangCurrencySwitcher /></div>
        </div>
      )}
    </header>
  );
}

function SearchOverlay({ initialQuery, onSearch, onClose }) {
  const { t } = useI18n();
  const [q, setQ] = useState(initialQuery || "");
  const ref = useRef(null);
  useEffect(() => { ref.current && ref.current.focus(); }, []);
  const submit = (e) => {
    e.preventDefault();
    onSearch(q);
  };
  return (
    <div className="phx-search-overlay" onClick={onClose}>
      <div className="phx-search-box" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit} className="phx-search-row">
          <Search size={20} style={{ marginLeft: 14, color: "var(--ink-soft)", flexShrink: 0 }} />
          <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.placeholder")} />
          <button type="button" className="phx-icon-btn" onClick={onClose} style={{ marginRight: 6 }}><X size={18} /></button>
        </form>
      </div>
    </div>
  );
}

/* =========================================================================
   CART DRAWER
   ========================================================================= */

function CartDrawer({ items, subtotal, onClose, onUpdateQty, onRemove, onNavigate }) {
  const { t, lang, formatMoney } = useI18n();
  return (
    <>
      <div className="phx-drawer-backdrop" onClick={onClose} />
      <div className="phx-drawer">
        <div className="phx-drawer-head">
          <h3>{t("cart.title")} ({items.length})</h3>
          <button className="phx-icon-btn" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="phx-drawer-body">
          {items.length === 0 ? (
            <EmptyState icon={ShoppingBag} title={t("cart.emptyTitle")} body={t("cart.emptyBody")} actionLabel={t("cart.browseShop")} onAction={() => { onClose(); onNavigate("catalog"); }} />
          ) : (
            items.map(({ product, qty }) => (
              <div className="phx-drawer-row" key={product.id}>
                <img src={product.image} alt={L(product.name, lang)} />
                <div>
                  <h5>{L(product.name, lang)}</h5>
                  <div className="phx-stepper" style={{ display: "inline-flex" }}>
                    <button onClick={() => onUpdateQty(product.id, qty - 1)} aria-label={t("common.decrease")}><Minus size={13} /></button>
                    <span style={{ fontSize: 13 }}>{qty}</span>
                    <button onClick={() => onUpdateQty(product.id, qty + 1)} aria-label={t("common.increase")}><Plus size={13} /></button>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="phx-price" style={{ marginBottom: 8 }}>{formatMoney(product.price * qty)}</div>
                  <button className="phx-icon-btn" style={{ width: 30, height: 30 }} onClick={() => onRemove(product.id)} aria-label={t("common.remove")}><Trash2 size={15} /></button>
                </div>
              </div>
            ))
          )}
        </div>
        {items.length > 0 && (
          <div className="phx-drawer-foot">
            <div className="phx-summary-row"><span>{t("cart.subtotal")}</span><span className="phx-price">{formatMoney(subtotal)}</span></div>
            <p style={{ fontSize: 12, marginBottom: 16 }}>{t("cart.taxNote")}</p>
            <button className="phx-btn phx-btn-primary phx-btn-block" onClick={() => { onClose(); onNavigate("checkout"); }}>
              {t("cart.checkout")} <ArrowRight size={16} />
            </button>
            <button className="phx-btn phx-btn-ghost phx-btn-block" style={{ marginTop: 8 }} onClick={() => { onClose(); onNavigate("cart"); }}>{t("cart.viewFullBag")}</button>
          </div>
        )}
      </div>
    </>
  );
}

/* =========================================================================
   HOME PAGE
   ========================================================================= */

function HomePage({ products, onNavigate, onSelectProduct, onQuickAdd }) {
  const { t, lang, formatMoney } = useI18n();
  const sorted = useMemo(() => [...products].sort((a, b) => new Date(b.date_added) - new Date(a.date_added)), [products]);
  const featured = sorted[0];
  const newArrivals = sorted.slice(0, 4);

  const catCounts = useMemo(() => {
    const counts = {};
    CATEGORIES.forEach((c) => (counts[c] = 0));
    products.forEach((p) => { counts[p.category] = (counts[p.category] || 0) + 1; });
    return counts;
  }, [products]);

  return (
    <>
      <section className="phx-hero">
        <div className="phx-container phx-hero-grid">
          <div className="phx-anim-up">
            <span className="phx-eyebrow">{t("home.eyebrow")}</span>
            <h1>{t("home.heroTitlePre")}<em>{t("home.heroTitleEm")}</em>{t("home.heroTitlePost")}</h1>
            <p className="lead">{t("home.lead")}</p>
            <div className="phx-hero-ctas">
              <button className="phx-btn phx-btn-primary" onClick={() => onNavigate("catalog")}>{t("home.shopCollection")} <ArrowRight size={16} /></button>
              <button className="phx-btn phx-btn-outline" onClick={() => onNavigate("about")}>{t("home.ourStory")}</button>
            </div>
          </div>
          <div className="phx-hero-visual phx-anim-up phx-anim-up-2">
            {featured && (
              <div className="phx-hero-card" onClick={() => onSelectProduct(featured.id)} style={{ cursor: "pointer" }}>
                <img src={featured.image} alt={L(featured.name, lang)} />
                <span className="phx-hero-ribbon"><Sparkles size={12} /> {t("product.inStock")}</span>
                <div className="phx-hero-tag">
                  <div className="phx-price">{formatMoney(featured.price)}</div>
                  <div className="name">{L(featured.name, lang)}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="phx-section">
        <div className="phx-container">
          <div className="phx-cat-grid">
            {CATEGORIES.map((cat) => {
              const meta = CATEGORY_META[cat];
              const Icon = meta.icon;
              const n = catCounts[cat];
              return (
                <button key={cat} className="phx-cat-card" onClick={() => onNavigate("catalog", { category: cat })}>
                  <span className="phx-cat-icon" style={{ background: "var(--mist)", color: meta.color }}><Icon size={24} /></span>
                  <span>
                    <h3>{t(`category.${cat}`)}</h3>
                    <p>{n} {lang === "ru" ? pluralRu(n, [t("home.pieceOne"), t("home.pieceFew"), t("home.pieceMany")]) : t("home.pieceOne")}</p>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="phx-section" style={{ paddingTop: 0 }}>
        <div className="phx-container">
          <div className="phx-results-bar">
            <div>
              <span className="phx-eyebrow">{t("home.justIn")}</span>
              <h2 style={{ marginTop: 6 }}>{t("home.newArrivals")}</h2>
            </div>
            <button className="phx-btn phx-btn-ghost" onClick={() => onNavigate("catalog")}>{t("home.viewAll")} <ChevronRight size={16} /></button>
          </div>
          {newArrivals.length === 0 ? (
            <EmptyState title={t("home.noProductsTitle")} body={t("home.noProductsBody")} />
          ) : (
            <div className="phx-product-grid">
              {newArrivals.map((p, i) => (
                <ProductCard key={p.id} product={p} index={i} onSelect={onSelectProduct} onQuickAdd={onQuickAdd} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="phx-container" style={{ marginBottom: 72 }}>
        <div className="phx-value-band">
          <div className="phx-value-grid">
            <div className="phx-value-item"><Sparkles size={26} /><h4>{t("home.valueDesignTitle")}</h4><p>{t("home.valueDesignBody")}</p></div>
            <div className="phx-value-item"><Check size={26} /><h4>{t("home.valueLastTitle")}</h4><p>{t("home.valueLastBody")}</p></div>
            <div className="phx-value-item"><ArrowRight size={26} /><h4>{t("home.valueExchangeTitle")}</h4><p>{t("home.valueExchangeBody")}</p></div>
          </div>
        </div>
      </section>

      <section className="phx-container" style={{ marginBottom: 90 }}>
        <div className="phx-cta-band">
          <PhoenixMark size={44} />
          <h2 style={{ marginTop: 16 }}>{t("home.ctaTitle")}</h2>
          <button className="phx-btn phx-btn-primary" onClick={() => onNavigate("catalog")}>{t("home.ctaButton")}</button>
        </div>
      </section>
    </>
  );
}

/* =========================================================================
   CATALOG PAGE
   ========================================================================= */

function FilterPanel({ categories, activeCategories, onToggleCategory, priceBounds, priceValue, onPriceChange, onClear, hasActiveFilters }) {
  const { t } = useI18n();
  return (
    <>
      <div className="phx-filter-block">
        <h4>{t("catalog.categoryHeading")}</h4>
        {categories.map((cat) => {
          const active = activeCategories.includes(cat);
          return (
            <div key={cat} className={`phx-cat-check ${active ? "is-active" : ""}`} onClick={() => onToggleCategory(cat)} style={{ cursor: "pointer" }}>
              <span className={`phx-checkbox ${active ? "is-checked" : ""}`}>{active && <Check size={12} />}</span>
              <CategoryIcon category={cat} size={14} />
              {t(`category.${cat}`)}
            </div>
          );
        })}
      </div>
      <div className="phx-filter-block">
        <h4>{t("catalog.priceHeading")}</h4>
        <PriceRange min={priceBounds[0]} max={priceBounds[1]} value={priceValue} onChange={onPriceChange} />
      </div>
      {hasActiveFilters && <button className="phx-clear-filters" onClick={onClear}>{t("catalog.clearFilters")}</button>}
    </>
  );
}

function CatalogPage({ products, initialCategory, initialQuery, onSelectProduct, onQuickAdd }) {
  const { t, lang } = useI18n();
  const priceBounds = useMemo(() => {
    if (products.length === 0) return [0, 100];
    const prices = products.map((p) => Number(p.price));
    return [Math.floor(Math.min(...prices)), Math.ceil(Math.max(...prices))];
  }, [products]);

  const [query, setQuery] = useState(initialQuery || "");
  const [activeCategories, setActiveCategories] = useState(initialCategory ? [initialCategory] : []);
  const [priceValue, setPriceValue] = useState(priceBounds);
  const [sort, setSort] = useState("newest");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  useEffect(() => { setPriceValue(priceBounds); }, [priceBounds[0], priceBounds[1]]);
  useEffect(() => { if (initialCategory) setActiveCategories([initialCategory]); }, [initialCategory]);
  useEffect(() => { setQuery(initialQuery || ""); }, [initialQuery]);

  const toggleCategory = (cat) => {
    setActiveCategories((prev) => prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]);
  };
  const clearFilters = () => { setActiveCategories([]); setPriceValue(priceBounds); setQuery(""); };
  const hasActiveFilters = activeCategories.length > 0 || query.trim() !== "" || priceValue[0] !== priceBounds[0] || priceValue[1] !== priceBounds[1];

  const filtered = useMemo(() => {
    let list = products.filter((p) => {
      const inCategory = activeCategories.length === 0 || activeCategories.includes(p.category);
      const inPrice = Number(p.price) >= priceValue[0] && Number(p.price) <= priceValue[1];
      const q = query.trim().toLowerCase();
      const haystack = `${L(p.name, lang)} ${L(p.description, lang)} ${p.category}`.toLowerCase();
      const inQuery = !q || haystack.includes(q);
      return inCategory && inPrice && inQuery;
    });
    switch (sort) {
      case "price-asc": list = [...list].sort((a, b) => a.price - b.price); break;
      case "price-desc": list = [...list].sort((a, b) => b.price - a.price); break;
      case "name": list = [...list].sort((a, b) => L(a.name, lang).localeCompare(L(b.name, lang))); break;
      default: list = [...list].sort((a, b) => new Date(b.date_added) - new Date(a.date_added));
    }
    return list;
  }, [products, activeCategories, priceValue, query, sort, lang]);

  const count = filtered.length;
  const countLabel = lang === "ru"
    ? pluralRu(count, [t("catalog.productOne"), t("catalog.productFew"), t("catalog.productMany")])
    : t("catalog.productOne");

  return (
    <>
      <div className="phx-page-head">
        <div className="phx-container">
          <span className="phx-eyebrow">{t("catalog.eyebrow")}</span>
          <h1>{t("catalog.title")}</h1>
        </div>
      </div>
      <div className="phx-container phx-catalog-layout">
        <aside className="phx-filters">
          <div className="phx-field" style={{ marginBottom: 26 }}>
            <div style={{ position: "relative" }}>
              <Search size={16} style={{ position: "absolute", left: 14, top: 13, color: "var(--ink-soft)" }} />
              <input className="phx-input" style={{ paddingLeft: 38 }} placeholder={t("catalog.searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>
          <button className="phx-btn phx-btn-outline phx-btn-block phx-filter-toggle" style={{ marginBottom: 18 }} onClick={() => setMobileFiltersOpen((v) => !v)}>
            {mobileFiltersOpen ? t("catalog.hideFilters") : t("catalog.showFilters")}
          </button>
          <div className={`phx-filters-content ${mobileFiltersOpen ? "is-open" : ""}`}>
            <FilterPanel categories={CATEGORIES} activeCategories={activeCategories} onToggleCategory={toggleCategory}
              priceBounds={priceBounds} priceValue={priceValue} onPriceChange={setPriceValue} onClear={clearFilters} hasActiveFilters={hasActiveFilters} />
          </div>
        </aside>
        <div>
          <div className="phx-results-bar">
            <span className="phx-results-count">{count} {countLabel}</span>
            <div className="phx-select-wrap">
              <select className="phx-sort-select" value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="newest">{t("sort.newest")}</option>
                <option value="price-asc">{t("sort.priceAsc")}</option>
                <option value="price-desc">{t("sort.priceDesc")}</option>
                <option value="name">{t("sort.name")}</option>
              </select>
              <ChevronDown size={14} />
            </div>
          </div>
          {filtered.length === 0 ? (
            <EmptyState title={t("catalog.noMatchTitle")} body={t("catalog.noMatchBody")} actionLabel={t("catalog.clearFiltersAction")} onAction={clearFilters} />
          ) : (
            <div className="phx-product-grid">
              {filtered.map((p, i) => <ProductCard key={p.id} product={p} index={i} onSelect={onSelectProduct} onQuickAdd={onQuickAdd} />)}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* =========================================================================
   PRODUCT DETAIL PAGE
   ========================================================================= */

function ProductPage({ product, allProducts, onNavigate, onSelectProduct, onAddToCart }) {
  const { t, lang, formatMoney } = useI18n();
  const [qty, setQty] = useState(1);
  useEffect(() => { setQty(1); }, [product && product.id]);

  if (!product) {
    return (
      <div className="phx-container">
        <EmptyState title={t("product.notFoundTitle")} body={t("product.notFoundBody")} actionLabel={t("product.backToShop")} onAction={() => onNavigate("catalog")} />
      </div>
    );
  }

  const name = L(product.name, lang);
  const description = L(product.description, lang);
  const stock = Number(product.stock ?? 0);
  const lowThreshold = Number(product.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD);
  const outOfStock = stock <= 0;
  const lowStock = !outOfStock && stock <= lowThreshold;
  const stockClass = outOfStock ? "is-out" : lowStock ? "is-low" : "is-in";
  const stockLabel = outOfStock ? t("product.outOfStock") : lowStock ? t("product.lowStock") : t("product.inStock");

  const related = allProducts.filter((p) => p.category === product.category && p.id !== product.id).slice(0, 3);

  return (
    <div className="phx-container">
      <div className="phx-page-head" style={{ border: "none", paddingBottom: 0 }}>
        <div className="phx-breadcrumb">
          <a href="#" onClick={(e) => { e.preventDefault(); onNavigate("home"); }}>{t("product.breadcrumbHome")}</a>
          <ChevronRight size={13} />
          <a href="#" onClick={(e) => { e.preventDefault(); onNavigate("catalog"); }}>{t("product.breadcrumbShop")}</a>
          <ChevronRight size={13} />
          <span>{name}</span>
        </div>
      </div>
      <div className="phx-product-detail">
        <div className="phx-product-image">
          <img src={product.image} alt={name} />
        </div>
        <div className="phx-product-info">
          <span className="phx-badge-pill"><CategoryIcon category={product.category} size={13} /> {t(`category.${product.category}`)}</span>
          <h1>{name}</h1>
          <span className="phx-price">{formatMoney(product.price)}</span>
          <span className={`phx-stock-badge ${stockClass}`}>
            <span className="dot" /> {stockLabel}{!outOfStock && ` · ${stock}`}
          </span>
          <p className="desc">{description}</p>
          <div className="phx-qty-row">
            <div className="phx-stepper">
              <button onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={outOfStock} aria-label={t("common.decrease")}><Minus size={15} /></button>
              <span>{qty}</span>
              <button onClick={() => setQty((q) => Math.min(stock, q + 1))} disabled={outOfStock || qty >= stock} aria-label={t("common.increase")}><Plus size={15} /></button>
            </div>
            <button className="phx-btn phx-btn-primary" disabled={outOfStock} onClick={() => onAddToCart(product, qty)}>
              <ShoppingBag size={16} /> {t("product.addToBag")}
            </button>
          </div>
          <button className="phx-btn phx-btn-ghost" onClick={() => onNavigate("catalog")}><ArrowLeft size={15} /> {t("product.backToShop")}</button>
        </div>
      </div>
      {related.length > 0 && (
        <div className="phx-related" style={{ paddingBottom: 70 }}>
          <h3>{t("product.related")}</h3>
          <div className="phx-product-grid">
            {related.map((p, i) => <ProductCard key={p.id} product={p} index={i} onSelect={onSelectProduct} onQuickAdd={(prod) => onAddToCart(prod, 1)} />)}
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================================================================
   CART PAGE
   ========================================================================= */

function CartPage({ items, subtotal, onNavigate, onUpdateQty, onRemove }) {
  const { t, lang, formatMoney } = useI18n();
  if (items.length === 0) {
    return (
      <div className="phx-container">
        <EmptyState icon={ShoppingBag} title={t("cartPage.emptyTitle")} body={t("cartPage.emptyBody")} actionLabel={t("cartPage.shopNow")} onAction={() => onNavigate("catalog")} />
      </div>
    );
  }
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FLAT;
  return (
    <div className="phx-container">
      <div className="phx-page-head"><h1>{t("cartPage.title")}</h1></div>
      <div className="phx-cart-layout">
        <div>
          {items.map(({ product, qty }) => {
            const stock = Number(product.stock ?? Infinity);
            return (
              <div className="phx-cart-row" key={product.id}>
                <img src={product.image} alt={L(product.name, lang)} />
                <div>
                  <h4>{L(product.name, lang)}</h4>
                  <div className="cat">{t(`category.${product.category}`)}</div>
                  <div className="phx-cart-row-actions">
                    <div className="phx-stepper">
                      <button onClick={() => onUpdateQty(product.id, qty - 1)} aria-label={t("common.decrease")}><Minus size={14} /></button>
                      <span>{qty}</span>
                      <button onClick={() => onUpdateQty(product.id, Math.min(stock, qty + 1))} disabled={qty >= stock} aria-label={t("common.increase")}><Plus size={14} /></button>
                    </div>
                    <button className="phx-btn phx-btn-ghost phx-btn-sm" onClick={() => onRemove(product.id)}><Trash2 size={14} /> {t("cartPage.remove")}</button>
                  </div>
                </div>
                <div className="line-total phx-price">{formatMoney(product.price * qty)}</div>
              </div>
            );
          })}
          <button className="phx-btn phx-btn-outline" style={{ marginTop: 22 }} onClick={() => onNavigate("catalog")}><ArrowLeft size={15} /> {t("cartPage.continueShopping")}</button>
        </div>
        <div className="phx-summary-card">
          <h3 style={{ marginBottom: 18 }}>{t("cartPage.summary")}</h3>
          <div className="phx-summary-row"><span>{t("cartPage.subtotal")}</span><span className="phx-price">{formatMoney(subtotal)}</span></div>
          <div className="phx-summary-row"><span>{t("cartPage.shipping")}</span><span className="phx-price">{shipping === 0 ? t("cartPage.free") : formatMoney(shipping)}</span></div>
          {shipping > 0 && <p style={{ fontSize: 12, marginBottom: 10 }}>{t("cartPage.freeShippingNote", { amount: formatMoney(FREE_SHIPPING_THRESHOLD) })}</p>}
          <div className="phx-summary-row total"><span>{t("cartPage.total")}</span><span className="phx-price">{formatMoney(subtotal + shipping)}</span></div>
          <button className="phx-btn phx-btn-primary phx-btn-block" style={{ marginTop: 14 }} onClick={() => onNavigate("checkout")}>{t("cartPage.proceed")} <ArrowRight size={16} /></button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   CHECKOUT PAGE
   ========================================================================= */

function CheckoutPage({ items, subtotal, coupons, onNavigate, onPlaceOrder }) {
  const { t, lang, formatMoney } = useI18n();
  const [form, setForm] = useState({ name: "", email: "", phone: "", address: "", city: "", note: "" });
  const [payment, setPayment] = useState("cod");
  const [couponInput, setCouponInput] = useState("");
  const [couponState, setCouponState] = useState(null); // { coupon } | { error }
  const [errors, setErrors] = useState({});
  const [order, setOrder] = useState(null);

  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FLAT;
  const discount = couponState && couponState.coupon ? computeDiscount(couponState.coupon, subtotal) : 0;
  const total = Math.max(0, subtotal - discount) + shipping;

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const applyCoupon = () => {
    const found = findCoupon(coupons, couponInput);
    const result = validateCoupon(found, subtotal);
    if (result.ok) {
      setCouponState({ coupon: found });
    } else {
      setCouponState({ error: result.reason, errorMin: found ? found.minOrder : 0 });
    }
  };
  const removeCoupon = () => { setCouponState(null); setCouponInput(""); };

  const validate = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = t("checkout.errName");
    if (!form.email.trim() || !/^\S+@\S+\.\S+$/.test(form.email)) errs.email = t("checkout.errEmail");
    if (!form.phone.trim()) errs.phone = t("checkout.errPhone");
    if (!form.address.trim()) errs.address = t("checkout.errAddress");
    if (!form.city.trim()) errs.city = t("checkout.errCity");
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const submit = (e) => {
    e.preventDefault();
    if (!validate()) return;
    const draft = {
      items: items.map(({ product, qty }) => ({
        productId: product.id, name: L(product.name, lang), qty, price: product.price,
      })),
      customer: { name: form.name, phone: form.phone, email: form.email, address: form.address, city: form.city, note: form.note },
      payment,
      subtotal, discount, shipping, total,
      couponCode: couponState && couponState.coupon ? couponState.coupon.code : null,
    };
    const newOrder = onPlaceOrder(draft);
    setOrder(newOrder);
  };

  if (order) {
    return (
      <div className="phx-container">
        <div className="phx-confirm-wrap">
          <div className="phx-confirm-icon"><Check size={38} /></div>
          <h1>{t("checkout.confirmedTitle")}</h1>
          <p>{t("checkout.confirmedThanks", { name: order.customer.name.split(" ")[0] })}</p>
          <div className="phx-order-id">{order.id}</div>
          <div className="phx-confirm-summary">
            {order.items.map((line) => (
              <div className="phx-mini-row" key={line.productId}><span>{line.name} × {line.qty}</span><span className="n">{formatMoney(line.price * line.qty)}</span></div>
            ))}
            {order.discount > 0 && (
              <div className="phx-mini-row"><span>{t("coupon.discount")}</span><span className="n">−{formatMoney(order.discount)}</span></div>
            )}
            <div className="phx-mini-row" style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 6 }}><span>{t("checkout.summary")}</span><span className="n phx-price">{formatMoney(order.total)}</span></div>
          </div>
          <p style={{ marginBottom: 26 }}>{t("checkout.confirmedFollowUp")}</p>
          <button className="phx-btn phx-btn-primary" onClick={() => onNavigate("home")}>{t("checkout.backHome")}</button>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="phx-container">
        <EmptyState icon={ShoppingBag} title={t("checkout.emptyTitle")} body={t("checkout.emptyBody")} actionLabel={t("checkout.shopNow")} onAction={() => onNavigate("catalog")} />
      </div>
    );
  }

  return (
    <div className="phx-container">
      <div className="phx-page-head"><h1>{t("checkout.title")}</h1></div>
      <div className="phx-checkout-layout">
        <form onSubmit={submit}>
          <h3 style={{ marginBottom: 16 }}>{t("checkout.contact")}</h3>
          <div className="phx-field-row">
            <div className="phx-field">
              <label>{t("checkout.fullName")}</label>
              <input className={`phx-input ${errors.name ? "has-error" : ""}`} value={form.name} onChange={setField("name")} placeholder={t("checkout.namePlaceholder")} />
              {errors.name && <div className="phx-field-error">{errors.name}</div>}
            </div>
            <div className="phx-field">
              <label>{t("checkout.phone")}</label>
              <input className={`phx-input ${errors.phone ? "has-error" : ""}`} value={form.phone} onChange={setField("phone")} placeholder="+996 700 000 000" />
              {errors.phone && <div className="phx-field-error">{errors.phone}</div>}
            </div>
          </div>
          <div className="phx-field">
            <label>{t("checkout.email")}</label>
            <input type="email" className={`phx-input ${errors.email ? "has-error" : ""}`} value={form.email} onChange={setField("email")} placeholder="you@email.com" />
            {errors.email && <div className="phx-field-error">{errors.email}</div>}
          </div>
          <h3 style={{ margin: "24px 0 16px" }}>{t("checkout.delivery")}</h3>
          <div className="phx-field">
            <label>{t("checkout.address")}</label>
            <input className={`phx-input ${errors.address ? "has-error" : ""}`} value={form.address} onChange={setField("address")} placeholder={t("checkout.addressPlaceholder")} />
            {errors.address && <div className="phx-field-error">{errors.address}</div>}
          </div>
          <div className="phx-field">
            <label>{t("checkout.city")}</label>
            <input className={`phx-input ${errors.city ? "has-error" : ""}`} value={form.city} onChange={setField("city")} placeholder={t("checkout.cityPlaceholder")} />
            {errors.city && <div className="phx-field-error">{errors.city}</div>}
          </div>
          <div className="phx-field">
            <label>{t("checkout.note")} <span className="hint">({t("common.optional")})</span></label>
            <textarea className="phx-textarea" value={form.note} onChange={setField("note")} placeholder={t("checkout.notePlaceholder")} />
          </div>
          <h3 style={{ margin: "24px 0 16px" }}>{t("checkout.paymentMethod")}</h3>
          <div className="phx-payment-options">
            {PAYMENT_METHODS.map((m) => (
              <label key={m} className={`phx-payment-option ${payment === m ? "is-active" : ""}`}>
                <input type="radio" name="payment" value={m} checked={payment === m} onChange={() => setPayment(m)} />
                {t(`payment.${m}`)}
              </label>
            ))}
          </div>
          <button type="submit" className="phx-btn phx-btn-primary phx-btn-block" style={{ marginTop: 24 }}>{t("checkout.placeOrder")} <ArrowRight size={16} /></button>
        </form>
        <div className="phx-summary-card">
          <h3 style={{ marginBottom: 16 }}>{t("checkout.summary")}</h3>
          {items.map(({ product, qty }) => (
            <div className="phx-mini-row" key={product.id}><span>{L(product.name, lang)} × {qty}</span><span className="n">{formatMoney(product.price * qty)}</span></div>
          ))}
          <div className="phx-coupon-box">
            <label style={{ display: "block", marginBottom: 8, fontSize: 13, fontWeight: 600 }}>{t("coupon.label")}</label>
            {couponState && couponState.coupon ? (
              <div className="phx-coupon-applied">
                <span><TicketPercent size={14} /> {t("coupon.applied", { code: couponState.coupon.code })}</span>
                <button type="button" className="phx-btn phx-btn-ghost phx-btn-sm" onClick={removeCoupon}>{t("coupon.remove")}</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <input className="phx-input" style={{ textTransform: "uppercase" }} placeholder={t("coupon.placeholder")} value={couponInput}
                  onChange={(e) => { setCouponInput(e.target.value); setCouponState(null); }} />
                <button type="button" className="phx-btn phx-btn-outline phx-btn-sm" onClick={applyCoupon} disabled={!couponInput.trim()}>{t("coupon.apply")}</button>
              </div>
            )}
            {couponState && couponState.error && (
              <div className="phx-field-error">{t(`coupon.${couponState.error}`, { amount: formatMoney(couponState.errorMin || 0) })}</div>
            )}
          </div>
          <div className="phx-summary-row" style={{ marginTop: 14 }}><span>{t("cartPage.subtotal")}</span><span className="phx-price">{formatMoney(subtotal)}</span></div>
          {discount > 0 && (
            <div className="phx-summary-row"><span>{t("coupon.discount")}</span><span className="phx-price">−{formatMoney(discount)}</span></div>
          )}
          <div className="phx-summary-row"><span>{t("cartPage.shipping")}</span><span className="phx-price">{shipping === 0 ? t("cartPage.free") : formatMoney(shipping)}</span></div>
          <div className="phx-summary-row total"><span>{t("cartPage.total")}</span><span className="phx-price">{formatMoney(total)}</span></div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   ABOUT PAGE
   ========================================================================= */

function AboutPage({ onNavigate }) {
  const { t } = useI18n();
  const [contactForm, setContactForm] = useState({ name: "", email: "", message: "" });
  const [sent, setSent] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    if (!contactForm.name || !contactForm.email || !contactForm.message) return;
    setSent(true);
    setContactForm({ name: "", email: "", message: "" });
    setTimeout(() => setSent(false), 4000);
  };

  return (
    <>
      <div className="phx-container phx-about-hero">
        <span className="phx-eyebrow">{t("about.eyebrow")}</span>
        <h1>{t("about.titlePre")}<em>{t("about.titleEm")}</em>{t("about.titlePost")}</h1>
        <p style={{ fontSize: 16 }}>{t("about.lead")}</p>
      </div>
      <div className="phx-container">
        <div className="phx-values-grid">
          <div className="phx-value-card"><Sparkles size={24} /><h3>{t("about.renewalTitle")}</h3><p>{t("about.renewalBody")}</p></div>
          <div className="phx-value-card"><Check size={24} /><h3>{t("about.qualityTitle")}</h3><p>{t("about.qualityBody")}</p></div>
          <div className="phx-value-card"><ShoppingBag size={24} /><h3>{t("about.craftTitle")}</h3><p>{t("about.craftBody")}</p></div>
        </div>
      </div>
      <div className="phx-container" style={{ paddingBottom: 80 }}>
        <div className="phx-contact-grid">
          <div>
            <span className="phx-eyebrow">{t("about.getInTouch")}</span>
            <h2 style={{ margin: "10px 0 24px" }}>{t("about.loveToHear")}</h2>
            <div className="phx-contact-info-item"><span className="ic"><Mail size={18} /></span><div><h4>{t("about.emailLabel")}</h4><p>hello@phoenixstyle.example</p></div></div>
            <div className="phx-contact-info-item"><span className="ic"><Phone size={18} /></span><div><h4>{t("about.phoneLabel")}</h4><p>+996 700 000 000</p></div></div>
            <div className="phx-contact-info-item"><span className="ic"><MapPin size={18} /></span><div><h4>{t("about.showroomLabel")}</h4><p>{t("about.showroomValue")}</p></div></div>
            <div className="phx-contact-info-item"><span className="ic"><Clock size={18} /></span><div><h4>{t("about.hoursLabel")}</h4><p>{t("about.hoursValue")}</p></div></div>
          </div>
          <form onSubmit={submit} className="phx-admin-form-card" style={{ maxWidth: "none" }}>
            <div className="phx-field"><label>{t("about.formName")}</label><input className="phx-input" value={contactForm.name} onChange={(e) => setContactForm((f) => ({ ...f, name: e.target.value }))} placeholder={t("about.formNamePlaceholder")} /></div>
            <div className="phx-field"><label>{t("about.formEmail")}</label><input type="email" className="phx-input" value={contactForm.email} onChange={(e) => setContactForm((f) => ({ ...f, email: e.target.value }))} placeholder="you@email.com" /></div>
            <div className="phx-field"><label>{t("about.formMessage")}</label><textarea className="phx-textarea" value={contactForm.message} onChange={(e) => setContactForm((f) => ({ ...f, message: e.target.value }))} placeholder={t("about.formMessagePlaceholder")} /></div>
            <button className="phx-btn phx-btn-primary phx-btn-block" type="submit">{sent ? t("about.sent") : t("about.send")}</button>
          </form>
        </div>
      </div>
    </>
  );
}

/* =========================================================================
   ADMIN — LOGIN
   ========================================================================= */

function AdminLoginPage({ adminConfig, onSetup, onLogin, onNavigate }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const isFirstRun = adminConfig === null;

  const submit = (e) => {
    e.preventDefault();
    setError("");
    if (isFirstRun) {
      if (password.length < 6) return setError(t("adminLogin.errShort"));
      if (password !== confirm) return setError(t("adminLogin.errMatch"));
      onSetup(password);
    } else {
      if (!onLogin(password)) setError(t("adminLogin.errWrong"));
    }
  };

  return (
    <div className="phx-admin-login-wrap">
      <div className="phx-admin-card">
        <div className="phx-admin-mark"><PhoenixMark size={32} /></div>
        <h2>{isFirstRun ? t("adminLogin.setupTitle") : t("adminLogin.loginTitle")}</h2>
        <p className="sub">{isFirstRun ? t("adminLogin.setupSub") : t("adminLogin.loginSub")}</p>
        {error && <div className="phx-admin-error"><AlertCircle size={16} /> {error}</div>}
        <form onSubmit={submit}>
          <div className="phx-field" style={{ textAlign: "left" }}>
            <label>{t("adminLogin.password")}</label>
            <input type="password" className="phx-input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoFocus />
          </div>
          {isFirstRun && (
            <div className="phx-field" style={{ textAlign: "left" }}>
              <label>{t("adminLogin.confirmPassword")}</label>
              <input type="password" className="phx-input" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" />
            </div>
          )}
          <button className="phx-btn phx-btn-dark phx-btn-block" type="submit">{isFirstRun ? t("adminLogin.createPassword") : t("adminLogin.logIn")}</button>
        </form>
        <button className="phx-btn phx-btn-ghost" style={{ marginTop: 14 }} onClick={() => onNavigate("home")}><ArrowLeft size={14} /> {t("adminLogin.backHome")}</button>
      </div>
    </div>
  );
}

/* =========================================================================
   ADMIN — PRODUCT FORM
   ========================================================================= */

function ProductForm({ initial, onSave, onCancel }) {
  const { t } = useI18n();
  const emptyForm = () => ({
    name: { ru: "", ky: "" }, description: { ru: "", ky: "" },
    price: "", category: "Clothing", image: "",
    stock: "0", lowStockThreshold: String(DEFAULT_LOW_STOCK_THRESHOLD),
  });
  const normalize = (p) => {
    if (!p) return emptyForm();
    const asDict = (field) => (typeof field === "string" ? { ru: field, ky: "" } : { ru: field?.ru || "", ky: field?.ky || "" });
    return {
      ...p,
      name: asDict(p.name),
      description: asDict(p.description),
      price: String(p.price ?? ""),
      stock: String(p.stock ?? "0"),
      lowStockThreshold: String(p.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD),
    };
  };

  const [form, setForm] = useState(() => normalize(initial));
  const [formLang, setFormLang] = useState(FALLBACK_LANG);
  const [errors, setErrors] = useState({});
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => { setForm(normalize(initial)); setErrors({}); }, [initial]);

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setLocalizedField = (key, lng) => (e) => setForm((f) => ({ ...f, [key]: { ...f[key], [lng]: e.target.value } }));

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await resizeImageFile(file);
      setForm((f) => ({ ...f, image: dataUrl }));
    } catch {
      setErrors((er) => ({ ...er, image: t("productForm.errImage") }));
    } finally {
      setUploading(false);
    }
  };

  const validate = () => {
    const errs = {};
    if (!form.name.ru.trim() && !form.name.ky.trim()) errs.name = t("productForm.errName");
    if (!form.price || Number(form.price) <= 0) errs.price = t("productForm.errPrice");
    if (!CATEGORIES.includes(form.category)) errs.category = t("productForm.errCategory");
    if (form.stock === "" || Number(form.stock) < 0) errs.stock = t("productForm.errStock");
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const submit = (e) => {
    e.preventDefault();
    if (!validate()) return;
    const nameForPlaceholder = form.name.ru || form.name.ky || "?";
    const image = form.image || placeholderImage(nameForPlaceholder, form.category);
    onSave({
      ...form,
      price: Number(form.price),
      stock: Number(form.stock),
      lowStockThreshold: Number(form.lowStockThreshold) || DEFAULT_LOW_STOCK_THRESHOLD,
      image,
    });
  };

  return (
    <form className="phx-admin-form-card" onSubmit={submit}>
      <div className="phx-field">
        <label>{t("productForm.image")}</label>
        <div className="phx-image-upload">
          <div className="phx-image-preview">
            {form.image ? <img src={form.image} alt={t("common.preview")} /> : <ImagePlus size={22} color="var(--ink-soft)" />}
          </div>
          <div>
            <button type="button" className="phx-btn phx-btn-outline phx-btn-sm phx-upload-btn" onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading}>
              {uploading ? <Loader2 size={14} className="phx-spin" /> : <ImagePlus size={14} />} {form.image ? t("productForm.changeImage") : t("productForm.uploadImage")}
            </button>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFile} />
            <p style={{ fontSize: 12, marginTop: 8 }}>{t("productForm.noImageNote")}</p>
          </div>
        </div>
      </div>

      <div className="phx-lang-tabs">
        {LANGUAGES.map((l) => (
          <button type="button" key={l.code} className={`phx-lang-tab ${formLang === l.code ? "is-active" : ""}`} onClick={() => setFormLang(l.code)}>
            {l.name}
          </button>
        ))}
      </div>
      <p style={{ fontSize: 12, margin: "-8px 0 14px" }}>{t("productForm.langTabHint")}</p>

      <div className="phx-field">
        <label>{t("productForm.nameLabel")} ({LANGUAGES.find((l) => l.code === formLang).short})</label>
        <input className={`phx-input ${errors.name ? "has-error" : ""}`} value={form.name[formLang]} onChange={setLocalizedField("name", formLang)} placeholder={t("productForm.namePlaceholder")} />
        {errors.name && <div className="phx-field-error">{errors.name}</div>}
      </div>
      <div className="phx-field">
        <label>{t("productForm.descriptionLabel")} ({LANGUAGES.find((l) => l.code === formLang).short})</label>
        <textarea className="phx-textarea" value={form.description[formLang]} onChange={setLocalizedField("description", formLang)} placeholder={t("productForm.descriptionPlaceholder")} />
      </div>

      <div className="phx-field-row">
        <div className="phx-field">
          <label>{t("productForm.priceLabel")}</label>
          <input type="number" min="0" step="1" className={`phx-input ${errors.price ? "has-error" : ""}`} value={form.price} onChange={setField("price")} placeholder="0" />
          {errors.price && <div className="phx-field-error">{errors.price}</div>}
        </div>
        <div className="phx-field">
          <label>{t("productForm.categoryLabel")}</label>
          <select className="phx-select" value={form.category} onChange={setField("category")}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
          </select>
        </div>
      </div>
      <div className="phx-field-row">
        <div className="phx-field">
          <label>{t("productForm.stockLabel")}</label>
          <input type="number" min="0" step="1" className={`phx-input ${errors.stock ? "has-error" : ""}`} value={form.stock} onChange={setField("stock")} placeholder="0" />
          {errors.stock && <div className="phx-field-error">{errors.stock}</div>}
        </div>
        <div className="phx-field">
          <label>{t("productForm.lowStockLabel")}</label>
          <input type="number" min="0" step="1" className="phx-input" value={form.lowStockThreshold} onChange={setField("lowStockThreshold")} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="phx-btn phx-btn-primary">{initial ? t("productForm.update") : t("productForm.addProduct")}</button>
        {initial && <button type="button" className="phx-btn phx-btn-outline" onClick={onCancel}>{t("productForm.cancel")}</button>}
      </div>
    </form>
  );
}

/* =========================================================================
   ADMIN — DASHBOARD
   ========================================================================= */

/* =========================================================================
   ADMIN — ORDERS PANEL
   ========================================================================= */

function OrdersPanel({ orders, onUpdateStatus }) {
  const { t, formatMoney } = useI18n();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedId, setExpandedId] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      const matchesQ = !q || o.id.toLowerCase().includes(q) || o.customer.name.toLowerCase().includes(q) || o.customer.phone.toLowerCase().includes(q);
      const matchesStatus = statusFilter === "all" || o.status === statusFilter;
      return matchesQ && matchesStatus;
    });
  }, [orders, search, statusFilter]);

  if (orders.length === 0) {
    return <EmptyState icon={Receipt} title={t("admin.ordersEmptyTitle")} body={t("admin.ordersEmptyBody")} />;
  }

  return (
    <>
      <div className="phx-admin-filter-row">
        <div className="phx-field" style={{ maxWidth: 320 }}>
          <input className="phx-input" placeholder={t("admin.searchInventory")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="phx-select-wrap">
          <select className="phx-sort-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">{t("admin.allStatuses")}</option>
            {ORDER_STATUSES.map((s) => <option key={s} value={s}>{t(`admin.status.${s}`)}</option>)}
          </select>
          <ChevronDown size={14} />
        </div>
      </div>
      <div className="phx-admin-table-wrap">
        <div className="phx-table-scroll">
          <table className="phx-admin-table">
            <thead>
              <tr>
                <th>{t("admin.colOrder")}</th><th>{t("admin.colCustomer")}</th><th>{t("admin.colDate")}</th>
                <th>{t("admin.colTotal")}</th><th>{t("admin.colStatus")}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <Fragment key={o.id}>
                  <tr>
                    <td style={{ fontWeight: 700 }}>{o.id}</td>
                    <td>{o.customer.name}<br /><span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{o.customer.phone}</span></td>
                    <td>{formatDate(o.createdAt)}</td>
                    <td className="phx-price">{formatMoney(o.total)}</td>
                    <td>
                      <select className="phx-status-select" data-status={o.status} value={o.status} onChange={(e) => onUpdateStatus(o.id, e.target.value)}>
                        {ORDER_STATUSES.map((s) => <option key={s} value={s}>{t(`admin.status.${s}`)}</option>)}
                      </select>
                    </td>
                    <td>
                      <button className="phx-icon-btn" style={{ width: 34, height: 34 }} onClick={() => setExpandedId(expandedId === o.id ? null : o.id)} aria-label={t("common.expand")}>
                        {expandedId === o.id ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                      </button>
                    </td>
                  </tr>
                  {expandedId === o.id && (
                    <tr>
                      <td colSpan={6}>
                        <div className="phx-order-detail">
                          <div>
                            <strong>{t("admin.orderDetailCustomer")}:</strong> {o.customer.name} · {o.customer.phone} · {o.customer.email}
                          </div>
                          <div><strong>{t("admin.orderDetailDelivery")}:</strong> {o.customer.address}, {o.customer.city}</div>
                          <div><strong>{t("admin.orderDetailNote")}:</strong> {o.customer.note || t("admin.orderDetailNoNote")}</div>
                          <div><strong>{t("checkout.paymentMethod")}:</strong> {t(`payment.${o.payment}`)}</div>
                          {o.couponCode && <div><strong>{t("admin.orderDetailCoupon")}:</strong> {o.couponCode}</div>}
                          <div style={{ marginTop: 10 }}>
                            <strong>{t("admin.orderDetailItems")}:</strong>
                            {o.items.map((line) => (
                              <div className="phx-mini-row" key={line.productId}><span>{line.name} × {line.qty}</span><span className="n">{formatMoney(line.price * line.qty)}</span></div>
                            ))}
                            {o.discount > 0 && <div className="phx-mini-row"><span>{t("coupon.discount")}</span><span className="n">−{formatMoney(o.discount)}</span></div>}
                            <div className="phx-mini-row"><span>{t("cartPage.total")}</span><span className="n phx-price">{formatMoney(o.total)}</span></div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* =========================================================================
   ADMIN — COUPONS PANEL
   ========================================================================= */

function CouponForm({ initial, onSave, onCancel }) {
  const { t } = useI18n();
  const emptyForm = () => ({ code: "", type: "percentage", value: "10", active: true, expiresAt: "", minOrder: "0", usageLimit: "0" });
  const [form, setForm] = useState(() => initial ? {
    code: initial.code, type: initial.type, value: String(initial.value), active: initial.active,
    expiresAt: initial.expiresAt || "", minOrder: String(initial.minOrder || 0), usageLimit: String(initial.usageLimit || 0),
  } : emptyForm());

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    if (!form.code.trim() || !form.value) return;
    onSave({
      code: form.code.trim().toUpperCase(), type: form.type, value: Number(form.value), active: form.active,
      expiresAt: form.expiresAt, minOrder: Number(form.minOrder) || 0, usageLimit: Number(form.usageLimit) || 0,
    });
  };

  return (
    <form className="phx-admin-form-card" onSubmit={submit}>
      <div className="phx-field-row">
        <div className="phx-field">
          <label>{t("admin.couponCodeLabel")}</label>
          <input className="phx-input" style={{ textTransform: "uppercase" }} value={form.code} onChange={setField("code")} placeholder={t("admin.couponCodePlaceholder")} />
        </div>
        <div className="phx-field">
          <label>{t("admin.couponTypeLabel")}</label>
          <select className="phx-select" value={form.type} onChange={setField("type")}>
            <option value="percentage">{t("admin.typePercentage")}</option>
            <option value="fixed">{t("admin.typeFixed")}</option>
          </select>
        </div>
      </div>
      <div className="phx-field-row">
        <div className="phx-field">
          <label>{t("admin.couponValueLabel")}</label>
          <input type="number" min="0" className="phx-input" value={form.value} onChange={setField("value")} />
        </div>
        <div className="phx-field">
          <label>{t("admin.couponMinOrderLabel")}</label>
          <input type="number" min="0" className="phx-input" value={form.minOrder} onChange={setField("minOrder")} />
        </div>
      </div>
      <div className="phx-field-row">
        <div className="phx-field">
          <label>{t("admin.couponExpiryLabel")}</label>
          <input type="date" className="phx-input" value={form.expiresAt} onChange={setField("expiresAt")} />
        </div>
        <div className="phx-field">
          <label>{t("admin.couponLimitLabel")}</label>
          <input type="number" min="0" className="phx-input" value={form.usageLimit} onChange={setField("usageLimit")} />
        </div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, fontSize: 14, fontWeight: 600 }}>
        <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
        {t("admin.couponActiveLabel")}
      </label>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="phx-btn phx-btn-primary">{initial ? t("common.update") : t("admin.addCoupon")}</button>
        <button type="button" className="phx-btn phx-btn-outline" onClick={onCancel}>{t("common.cancel")}</button>
      </div>
    </form>
  );
}

function CouponsPanel({ coupons, onAdd, onUpdate, onDelete }) {
  const { t, formatMoney } = useI18n();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const editing = editingId ? coupons.find((c) => c.id === editingId) : null;

  const handleSave = (data) => {
    if (editing) { onUpdate(editing.id, data); setEditingId(null); } else { onAdd(data); }
    setFormOpen(false);
  };

  return (
    <>
      {!formOpen && (
        <button className="phx-btn phx-btn-dark" style={{ marginBottom: 18 }} onClick={() => { setEditingId(null); setFormOpen(true); }}>
          <TicketPercent size={15} /> {t("admin.addCoupon")}
        </button>
      )}
      {formOpen && (
        <CouponForm key={editingId || "new"} initial={editing} onSave={handleSave} onCancel={() => { setFormOpen(false); setEditingId(null); }} />
      )}
      {coupons.length === 0 ? (
        <EmptyState icon={TicketPercent} title={t("admin.couponsEmptyTitle")} body={t("admin.couponsEmptyBody")} />
      ) : (
        <div className="phx-admin-table-wrap">
          <div className="phx-table-scroll">
            <table className="phx-admin-table">
              <thead>
                <tr>
                  <th>{t("admin.colCode")}</th><th>{t("admin.colType")}</th><th>{t("admin.colValue")}</th>
                  <th>{t("admin.colExpires")}</th><th>{t("admin.colUses")}</th><th>{t("admin.colActiveState")}</th><th></th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 700 }}>{c.code}</td>
                    <td>{c.type === "percentage" ? t("admin.typePercentage") : t("admin.typeFixed")}</td>
                    <td>{c.type === "percentage" ? `${c.value}%` : formatMoney(c.value)}</td>
                    <td>{c.expiresAt ? formatDate(c.expiresAt) : "—"}</td>
                    <td>{c.timesUsed || 0}{c.usageLimit ? ` / ${c.usageLimit}` : ""}</td>
                    <td><span className={`phx-status-pill ${c.active ? "is-on" : "is-off"}`}>{c.active ? t("common.active") : t("common.inactive")}</span></td>
                    <td>
                      <div className="phx-admin-row-actions">
                        <button className="phx-icon-btn" style={{ width: 34, height: 34 }} onClick={() => { setEditingId(c.id); setFormOpen(true); }} aria-label={t("common.edit")}><Pencil size={15} /></button>
                        <button className="phx-icon-btn" style={{ width: 34, height: 34 }} onClick={() => setConfirmDelete(c)} aria-label={t("common.delete")}><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        title={t("admin.confirmDeleteCouponTitle")}
        body={confirmDelete ? t("admin.confirmDeleteCouponBody", { code: confirmDelete.code }) : ""}
        confirmLabel={t("common.delete")}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { onDelete(confirmDelete.id); setConfirmDelete(null); }}
      />
    </>
  );
}

/* =========================================================================
   ADMIN — INVENTORY PANEL
   ========================================================================= */

function InventoryPanel({ products, onAdjustStock }) {
  const { t, lang, formatMoney } = useI18n();
  const [search, setSearch] = useState("");

  const withStatus = useMemo(() => products.map((p) => {
    const stock = Number(p.stock || 0);
    const threshold = Number(p.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD);
    const status = stock <= 0 ? "out" : stock <= threshold ? "low" : "ok";
    return { ...p, _status: status };
  }), [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return withStatus;
    return withStatus.filter((p) => L(p.name, lang).toLowerCase().includes(q));
  }, [withStatus, search, lang]);

  const lowStock = withStatus.filter((p) => p._status === "low");
  const outOfStock = withStatus.filter((p) => p._status === "out");

  return (
    <>
      {(lowStock.length > 0 || outOfStock.length > 0) && (
        <div className="phx-inventory-alerts">
          {outOfStock.length > 0 && (
            <div className="phx-alert-card is-out">
              <PackageX size={18} />
              <div><strong>{t("inventory.outOfStockAlert")}</strong><p>{outOfStock.map((p) => L(p.name, lang)).join(", ")}</p></div>
            </div>
          )}
          {lowStock.length > 0 && (
            <div className="phx-alert-card is-low">
              <AlertCircle size={18} />
              <div><strong>{t("inventory.lowStockAlert")}</strong><p>{lowStock.map((p) => L(p.name, lang)).join(", ")}</p></div>
            </div>
          )}
        </div>
      )}
      <div className="phx-field" style={{ maxWidth: 320, marginBottom: 18 }}>
        <input className="phx-input" placeholder={t("admin.searchInventory")} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="phx-admin-table-wrap">
        <div className="phx-table-scroll">
          <table className="phx-admin-table">
            <thead>
              <tr>
                <th>{t("inventory.colProduct")}</th><th>{t("inventory.colStock")}</th>
                <th>{t("inventory.colThreshold")}</th><th>{t("inventory.colStatus")}</th><th>{t("inventory.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <img className="phx-admin-thumb" src={p.image} alt={L(p.name, lang)} />
                      <span style={{ fontWeight: 600 }}>{L(p.name, lang)}</span>
                    </div>
                  </td>
                  <td style={{ fontWeight: 700 }}>{p.stock}</td>
                  <td>{p.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD}</td>
                  <td>
                    <span className={`phx-stock-badge ${p._status === "ok" ? "is-in" : p._status === "low" ? "is-low" : "is-out"}`}>
                      <span className="dot" /> {p._status === "ok" ? t("inventory.statusOk") : p._status === "low" ? t("inventory.statusLow") : t("inventory.statusOut")}
                    </span>
                  </td>
                  <td>
                    <div className="phx-admin-row-actions">
                      <button className="phx-btn phx-btn-outline phx-btn-sm" onClick={() => onAdjustStock(p.id, -1)} disabled={p.stock <= 0}><Minus size={13} /> {t("inventory.decrease")}</button>
                      <button className="phx-btn phx-btn-outline phx-btn-sm" onClick={() => onAdjustStock(p.id, 1)}><Plus size={13} /> {t("inventory.increase")}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* =========================================================================
   ADMIN — ANALYTICS PANEL
   ========================================================================= */

function AnalyticsPanel({ products, orders }) {
  const { t, formatMoney } = useI18n();

  const stats = useMemo(() => {
    const totalProducts = products.length;
    const totalOrders = orders.length;
    const revenue = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);
    const lowStockItems = products.filter((p) => {
      const stock = Number(p.stock || 0);
      const threshold = Number(p.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD);
      return stock <= threshold;
    }).length;
    const byStatus = ORDER_STATUSES.map((s) => ({ status: s, n: orders.filter((o) => o.status === s).length }));
    const maxStatus = Math.max(1, ...byStatus.map((s) => s.n));
    const byCategory = CATEGORIES.map((cat) => {
      const rev = orders.reduce((sum, o) => {
        const lines = o.items.filter((line) => {
          const prod = products.find((p) => p.id === line.productId);
          return prod && prod.category === cat;
        });
        return sum + lines.reduce((s, l) => s + l.price * l.qty, 0);
      }, 0);
      return { cat, rev };
    });
    const maxCategory = Math.max(1, ...byCategory.map((c) => c.rev));
    return { totalProducts, totalOrders, revenue, lowStockItems, byStatus, maxStatus, byCategory, maxCategory };
  }, [products, orders]);

  return (
    <>
      <div className="phx-stat-row">
        <div className="phx-stat-card"><div className="num">{stats.totalProducts}</div><div className="lbl">{t("analytics.totalProducts")}</div></div>
        <div className="phx-stat-card"><div className="num">{stats.totalOrders}</div><div className="lbl">{t("analytics.totalOrders")}</div></div>
        <div className="phx-stat-card"><div className="num">{formatMoney(stats.revenue)}</div><div className="lbl">{t("analytics.revenue")}</div></div>
        <div className="phx-stat-card"><div className="num">{stats.lowStockItems}</div><div className="lbl">{t("analytics.lowStockItems")}</div></div>
      </div>
      <div className="phx-analytics-grid">
        <div className="phx-chart-card">
          <h4>{t("analytics.ordersByStatus")}</h4>
          {orders.length === 0 ? <p style={{ fontSize: 13 }}>{t("analytics.noData")}</p> : stats.byStatus.map((s) => (
            <div className="phx-bar-row" key={s.status}>
              <span className="lbl">{t(`admin.status.${s.status}`)}</span>
              <div className="phx-bar-track"><div className="phx-bar-fill" style={{ width: `${(s.n / stats.maxStatus) * 100}%` }} /></div>
              <span className="val">{s.n}</span>
            </div>
          ))}
        </div>
        <div className="phx-chart-card">
          <h4>{t("analytics.revenueByCategory")}</h4>
          {orders.length === 0 ? <p style={{ fontSize: 13 }}>{t("analytics.noData")}</p> : stats.byCategory.map((c) => (
            <div className="phx-bar-row" key={c.cat}>
              <span className="lbl">{t(`category.${c.cat}`)}</span>
              <div className="phx-bar-track"><div className="phx-bar-fill" style={{ width: `${(c.rev / stats.maxCategory) * 100}%`, background: "var(--teal)" }} /></div>
              <span className="val">{formatMoney(c.rev)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* =========================================================================
   ADMIN — DASHBOARD
   ========================================================================= */

function AdminDashboard({
  products, orders, coupons, settings, adminConfig,
  onAddProduct, onUpdateProduct, onDeleteProduct, onAdjustStock,
  onUpdateOrderStatus, onAddCoupon, onUpdateCoupon, onDeleteCoupon,
  onUpdateSettings, onChangePassword, onLogout,
}) {
  const { t, lang, formatMoney } = useI18n();
  const [tab, setTab] = useState("overview");
  const [editingId, setEditingId] = useState(null);
  const [search, setSearch] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [pwMsg, setPwMsg] = useState(null);
  const [storeForm, setStoreForm] = useState({ defaultLanguage: settings.defaultLang, defaultCurrency: settings.defaultCurrency, exchangeRate: String(settings.exchangeRate) });
  const [storeMsg, setStoreMsg] = useState(null);

  const editing = editingId ? products.find((p) => p.id === editingId) : null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => `${L(p.name, lang)} ${p.category}`.toLowerCase().includes(q));
  }, [products, search, lang]);

  const stats = useMemo(() => {
    const total = products.length;
    const totalValue = products.reduce((sum, p) => sum + Number(p.price) * Number(p.stock || 0), 0);
    const revenue = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);
    const avgOrder = orders.length > 0 ? revenue / orders.length : 0;
    const lowStock = products.filter((p) => {
      const stock = Number(p.stock || 0);
      const threshold = Number(p.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD);
      return stock <= threshold;
    });
    const outOfStock = products.filter((p) => Number(p.stock || 0) <= 0);
    const salesByProduct = {};
    orders.forEach((o) => o.items.forEach((line) => {
      salesByProduct[line.productId] = (salesByProduct[line.productId] || 0) + line.qty;
    }));
    const topProducts = Object.entries(salesByProduct)
      .map(([id, qty]) => ({ product: products.find((p) => p.id === id), qty }))
      .filter((x) => x.product)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);
    return { total, totalValue, revenue, avgOrder, orderCount: orders.length, lowStock, outOfStock, topProducts };
  }, [products, orders]);

  const handleSave = (data) => {
    if (editing) {
      onUpdateProduct(editing.id, data);
      setEditingId(null);
    } else {
      onAddProduct(data);
    }
    setTab("products");
  };

  const submitPw = (e) => {
    e.preventDefault();
    setPwMsg(null);
    if (pwForm.current !== adminConfig.password) return setPwMsg({ type: "error", text: t("admin.errCurrentWrong") });
    if (pwForm.next.length < 6) return setPwMsg({ type: "error", text: t("admin.errNewShort") });
    if (pwForm.next !== pwForm.confirm) return setPwMsg({ type: "error", text: t("admin.errNewMatch") });
    onChangePassword(pwForm.next);
    setPwForm({ current: "", next: "", confirm: "" });
    setPwMsg({ type: "success", text: t("admin.passwordUpdated") });
  };

  const submitStore = (e) => {
    e.preventDefault();
    onUpdateSettings({
      defaultLang: storeForm.defaultLanguage,
      defaultCurrency: storeForm.defaultCurrency,
      exchangeRate: Number(storeForm.exchangeRate) || DEFAULT_EXCHANGE_RATE_RUB_PER_KGS,
    });
    setStoreMsg({ type: "success", text: t("admin.settingsSaved") });
  };

  const TABS = [
    { key: "overview", label: t("admin.tabOverview"), icon: LayoutGrid },
    { key: "products", label: t("admin.tabProducts"), icon: Shirt },
    { key: "orders", label: t("admin.tabOrders"), icon: Receipt },
    { key: "inventory", label: t("admin.tabInventory"), icon: PackagePlus },
    { key: "coupons", label: t("admin.tabCoupons"), icon: TicketPercent },
    { key: "analytics", label: t("admin.tabAnalytics"), icon: TrendingUp },
    { key: "add", label: t("admin.tabAdd"), icon: Plus },
    { key: "settings", label: t("admin.tabSettings"), icon: Settings },
  ];

  return (
    <div className="phx-container phx-admin-shell">
      <div className="phx-admin-topbar">
        <div>
          <span className="phx-eyebrow">{t("admin.subtitle")}</span>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 30, marginTop: 4 }}>{t("admin.title")}</h1>
        </div>
        <button className="phx-btn phx-btn-outline" onClick={onLogout}><LogOut size={15} /> {t("admin.logout")}</button>
      </div>

      <div className="phx-admin-tabs">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} className={`phx-admin-tab ${tab === key ? "is-active" : ""}`} onClick={() => { setTab(key); if (key !== "add") setEditingId(null); }}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <div className="phx-stat-row">
            <div className="phx-stat-card"><div className="num">{stats.total}</div><div className="lbl">{t("admin.statTotalProducts")}</div></div>
            <div className="phx-stat-card"><div className="num">{formatMoney(stats.totalValue)}</div><div className="lbl">{t("admin.statInventoryValue")}</div></div>
            <div className="phx-stat-card"><div className="num">{formatMoney(stats.revenue)}</div><div className="lbl">{t("admin.statRevenue")}</div></div>
            <div className="phx-stat-card"><div className="num">{stats.orderCount}</div><div className="lbl">{t("admin.statOrders")}</div></div>
            <div className="phx-stat-card"><div className="num">{formatMoney(stats.avgOrder)}</div><div className="lbl">{t("admin.statAvgOrder")}</div></div>
            <div className="phx-stat-card"><div className="num">{stats.lowStock.length}</div><div className="lbl">{t("admin.statLowStock")}</div></div>
          </div>
          <div className="phx-analytics-grid">
            <div className="phx-chart-card">
              <h4>{t("admin.lowStockHeading")}</h4>
              {stats.lowStock.length === 0 ? <p style={{ fontSize: 13 }}>{t("inventory.allGood")}</p> : stats.lowStock.map((p) => (
                <div className="phx-mini-row" key={p.id}><span>{L(p.name, lang)}</span><span className="n">{p.stock}</span></div>
              ))}
            </div>
            <div className="phx-chart-card">
              <h4>{t("admin.topProductsHeading")}</h4>
              {stats.topProducts.length === 0 ? <p style={{ fontSize: 13 }}>{t("admin.noSalesYet")}</p> : stats.topProducts.map(({ product, qty }) => (
                <div className="phx-mini-row" key={product.id}><span>{L(product.name, lang)}</span><span className="n">×{qty}</span></div>
              ))}
            </div>
          </div>
        </>
      )}

      {tab === "products" && (
        <>
          <div className="phx-field" style={{ maxWidth: 320, marginBottom: 18 }}>
            <input className="phx-input" placeholder={t("admin.searchInventory")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {filtered.length === 0 ? (
            <EmptyState icon={PackagePlus} title={t("admin.noProductsTitle")} body={t("admin.noProductsBody")} actionLabel={t("admin.tabAdd")} onAction={() => setTab("add")} />
          ) : (
            <div className="phx-admin-table-wrap">
              <div className="phx-table-scroll">
                <table className="phx-admin-table">
                  <thead>
                    <tr><th>{t("admin.colProduct")}</th><th>{t("admin.colCategory")}</th><th>{t("admin.colPrice")}</th><th>{t("admin.colStock")}</th><th>{t("admin.colAdded")}</th><th></th></tr>
                  </thead>
                  <tbody>
                    {filtered.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <img className="phx-admin-thumb" src={p.image} alt={L(p.name, lang)} />
                            <span style={{ fontWeight: 600 }}>{L(p.name, lang)}</span>
                          </div>
                        </td>
                        <td><span className="phx-admin-cat-badge"><CategoryIcon category={p.category} size={12} /> {t(`category.${p.category}`)}</span></td>
                        <td className="phx-price">{formatMoney(p.price)}</td>
                        <td>{p.stock}</td>
                        <td>{formatDate(p.date_added, lang)}</td>
                        <td>
                          <div className="phx-admin-row-actions">
                            <button className="phx-icon-btn" style={{ width: 34, height: 34 }} onClick={() => { setEditingId(p.id); setTab("add"); }} aria-label={t("common.edit")}><Pencil size={15} /></button>
                            <button className="phx-icon-btn" style={{ width: 34, height: 34 }} onClick={() => setConfirmDelete(p)} aria-label={t("common.delete")}><Trash2 size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "orders" && <OrdersPanel orders={orders} onUpdateStatus={onUpdateOrderStatus} />}

      {tab === "inventory" && <InventoryPanel products={products} onAdjustStock={onAdjustStock} />}

      {tab === "coupons" && <CouponsPanel coupons={coupons} onAdd={onAddCoupon} onUpdate={onUpdateCoupon} onDelete={onDeleteCoupon} />}

      {tab === "analytics" && <AnalyticsPanel products={products} orders={orders} />}

      {tab === "add" && (
        <ProductForm
          key={editingId || "new"}
          initial={editing}
          onSave={handleSave}
          onCancel={() => { setEditingId(null); setTab("products"); }}
        />
      )}

      {tab === "settings" && (
        <>
          <form className="phx-admin-form-card" onSubmit={submitPw}>
            <h3 style={{ marginBottom: 18 }}>{t("admin.settingsPasswordHeading")}</h3>
            {pwMsg && (
              <div className="phx-admin-error" style={pwMsg.type === "success" ? { background: "#E9F7EF", color: "#1E7A46" } : undefined}>
                {pwMsg.type === "error" ? <AlertCircle size={16} /> : <Check size={16} />} {pwMsg.text}
              </div>
            )}
            <div className="phx-field"><label>{t("admin.currentPassword")}</label><input type="password" className="phx-input" value={pwForm.current} onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))} /></div>
            <div className="phx-field-row">
              <div className="phx-field"><label>{t("admin.newPassword")}</label><input type="password" className="phx-input" value={pwForm.next} onChange={(e) => setPwForm((f) => ({ ...f, next: e.target.value }))} /></div>
              <div className="phx-field"><label>{t("admin.confirmNewPassword")}</label><input type="password" className="phx-input" value={pwForm.confirm} onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))} /></div>
            </div>
            <button className="phx-btn phx-btn-dark" type="submit">{t("admin.updatePassword")}</button>
          </form>

          <form className="phx-admin-form-card" onSubmit={submitStore} style={{ marginTop: 24 }}>
            <h3 style={{ marginBottom: 18 }}>{t("admin.settingsStoreHeading")}</h3>
            {storeMsg && (
              <div className="phx-admin-error" style={{ background: "#E9F7EF", color: "#1E7A46" }}>
                <Check size={16} /> {storeMsg.text}
              </div>
            )}
            <div className="phx-field-row">
              <div className="phx-field">
                <label>{t("admin.defaultLanguage")}</label>
                <select className="phx-select" value={storeForm.defaultLanguage} onChange={(e) => setStoreForm((f) => ({ ...f, defaultLanguage: e.target.value }))}>
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </select>
              </div>
              <div className="phx-field">
                <label>{t("admin.defaultCurrency")}</label>
                <select className="phx-select" value={storeForm.defaultCurrency} onChange={(e) => setStoreForm((f) => ({ ...f, defaultCurrency: e.target.value }))}>
                  {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                </select>
              </div>
            </div>
            <div className="phx-field">
              <label>{t("admin.exchangeRateLabel")}</label>
              <input type="number" min="0" step="0.01" className="phx-input" value={storeForm.exchangeRate} onChange={(e) => setStoreForm((f) => ({ ...f, exchangeRate: e.target.value }))} />
              <p style={{ fontSize: 12, marginTop: 6 }}>{t("admin.exchangeRateHint")}</p>
            </div>
            <button className="phx-btn phx-btn-dark" type="submit">{t("admin.saveSettings")}</button>
          </form>
        </>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={t("admin.confirmDeleteProductTitle")}
        body={confirmDelete ? t("admin.confirmDeleteProductBody", { name: L(confirmDelete.name, lang) }) : ""}
        confirmLabel={t("common.delete")}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { onDeleteProduct(confirmDelete.id); setConfirmDelete(null); }}
      />
    </div>
  );
}

/* =========================================================================
   FOOTER
   ========================================================================= */

function Footer({ onNavigate }) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [joined, setJoined] = useState(false);
  const submit = (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setJoined(true);
    setEmail("");
    setTimeout(() => setJoined(false), 3500);
  };
  return (
    <footer className="phx-footer">
      <div className="phx-container">
        <div className="phx-footer-grid">
          <div>
            <PhoenixLogo />
            <p style={{ marginTop: 14, fontSize: 13.5, maxWidth: 260 }}>{t("footer.tagline")}</p>
            <div className="phx-newsletter">
              <form onSubmit={submit} style={{ display: "flex", gap: 8, width: "100%" }}>
                <input type="email" placeholder={t("footer.emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} />
                <button type="submit">{joined ? t("footer.joined") : t("footer.join")}</button>
              </form>
            </div>
          </div>
          <div>
            <h5>{t("footer.shopHeading")}</h5>
            <ul>
              {CATEGORIES.map((c) => (
                <li key={c}><a href="#" onClick={(e) => { e.preventDefault(); onNavigate("catalog", { category: c }); }}>{t(`category.${c}`)}</a></li>
              ))}
              <li><a href="#" onClick={(e) => { e.preventDefault(); onNavigate("catalog"); }}>{t("footer.allProducts")}</a></li>
            </ul>
          </div>
          <div>
            <h5>{t("footer.companyHeading")}</h5>
            <ul>
              <li><a href="#" onClick={(e) => { e.preventDefault(); onNavigate("about"); }}>{t("footer.aboutUs")}</a></li>
              <li><a href="#" onClick={(e) => { e.preventDefault(); onNavigate("about"); }}>{t("footer.contact")}</a></li>
              <li><a href="#" onClick={(e) => { e.preventDefault(); onNavigate("admin-login"); }}>{t("footer.storeOwner")}</a></li>
            </ul>
          </div>
          <div>
            <h5>{t("footer.visitUs")}</h5>
            <ul>
              <li>{t("footer.locationValue")}</li>
              <li>{t("footer.hours")}</li>
              <li>hello@phoenixstyle.example</li>
            </ul>
          </div>
        </div>
        <div className="phx-footer-bottom">
          <span>© {new Date().getFullYear()} Phoenix Style House. {t("footer.rights")}</span>
          <span>{t("footer.craftedIn")}</span>
        </div>
      </div>
    </footer>
  );
}

/* =========================================================================
   APP ROOT
   ========================================================================= */

const DEFAULT_SETTINGS = { defaultLang: FALLBACK_LANG, defaultCurrency: BASE_CURRENCY, exchangeRate: DEFAULT_EXCHANGE_RATE_RUB_PER_KGS };

export default function App() {
  const [view, setView] = useState({ page: "home" });
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [orders, setOrders] = useState([]);
  const [coupons, setCoupons] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [lang, setLangState] = useState(FALLBACK_LANG);
  const [currency, setCurrencyState] = useState(BASE_CURRENCY);
  const [adminConfig, setAdminConfig] = useState(undefined); // undefined=loading, null=not set
  const [isAdmin, setIsAdmin] = useState(false);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const loadedRef = useRef(false);
  const toastTimer = useRef(null);

  useEffect(() => {
    (async () => {
      const [prod, cartData, admin, session, ordersData, couponsData, settingsData, savedLang, savedCurrency] = await Promise.all([
        storageGet(STORAGE_KEYS.PRODUCTS, true, null),
        storageGet(STORAGE_KEYS.CART, false, []),
        storageGet(STORAGE_KEYS.ADMIN_CONFIG, true, null),
        storageGet(STORAGE_KEYS.ADMIN_SESSION, false, false),
        storageGet(STORAGE_KEYS.ORDERS, true, []),
        storageGet(STORAGE_KEYS.COUPONS, true, []),
        storageGet(STORAGE_KEYS.SETTINGS, true, null),
        storageGet(STORAGE_KEYS.LANG, false, null),
        storageGet(STORAGE_KEYS.CURRENCY, false, null),
      ]);
      let finalProducts = prod;
      if (!finalProducts) {
        finalProducts = defaultProducts();
        storageSet(STORAGE_KEYS.PRODUCTS, finalProducts, true);
      }
      let finalCoupons = couponsData;
      if (!finalCoupons || finalCoupons.length === 0) {
        finalCoupons = [{ id: uid(), code: "WELCOME10", type: "percentage", value: 10, active: true, expiresAt: "", minOrder: 0, usageLimit: 0, timesUsed: 0 }];
        storageSet(STORAGE_KEYS.COUPONS, finalCoupons, true);
      }
      const finalSettings = { ...DEFAULT_SETTINGS, ...(settingsData || {}) };
      setProducts(finalProducts);
      setCart(Array.isArray(cartData) ? cartData : []);
      setOrders(Array.isArray(ordersData) ? ordersData : []);
      setCoupons(finalCoupons);
      setSettings(finalSettings);
      setLangState(savedLang || finalSettings.defaultLang || FALLBACK_LANG);
      setCurrencyState(savedCurrency || finalSettings.defaultCurrency || BASE_CURRENCY);
      setAdminConfig(admin);
      setIsAdmin(!!session && !!admin);
      loadedRef.current = true;
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    storageSet(STORAGE_KEYS.CART, cart, false);
  }, [cart]);

  const setLang = useCallback((next) => {
    setLangState(next);
    storageSet(STORAGE_KEYS.LANG, next, false);
  }, []);

  const setCurrency = useCallback((next) => {
    setCurrencyState(next);
    storageSet(STORAGE_KEYS.CURRENCY, next, false);
  }, []);

  const t = useCallback((path, vars) => {
    const dict = translations[lang] || translations[FALLBACK_LANG];
    const val = tPath(dict, path) ?? tPath(translations[FALLBACK_LANG], path) ?? path;
    return interpolate(val, vars);
  }, [lang]);

  const formatMoney = useCallback((amountKgs) => formatMoneyRaw(amountKgs, currency, lang, settings.exchangeRate), [currency, lang, settings.exchangeRate]);

  const i18nValue = useMemo(() => ({ t, lang, setLang, currency, setCurrency, formatMoney }), [t, lang, setLang, currency, setCurrency, formatMoney]);

  const showToast = useCallback((message) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ id: uid(), message });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const refreshProducts = useCallback(async () => {
    const prod = await storageGet(STORAGE_KEYS.PRODUCTS, true, null);
    if (prod) setProducts(prod);
  }, []);

  const refreshAdminData = useCallback(async () => {
    const [ord, coup] = await Promise.all([
      storageGet(STORAGE_KEYS.ORDERS, true, null),
      storageGet(STORAGE_KEYS.COUPONS, true, null),
    ]);
    if (ord) setOrders(ord);
    if (coup) setCoupons(coup);
  }, []);

  const navigate = useCallback((page, extra = {}) => {
    setCartOpen(false);
    setSearchOpen(false);
    if (["home", "catalog", "admin-dashboard"].includes(page)) refreshProducts();
    if (page === "admin-dashboard") refreshAdminData();
    setView({ page, ...extra });
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }, [refreshProducts, refreshAdminData]);

  const selectProduct = useCallback((id) => navigate("product", { productId: id }), [navigate]);

  /* ---- cart logic ---- */
  const cartItems = useMemo(() => {
    return cart
      .map((entry) => {
        const product = products.find((p) => p.id === entry.productId);
        return product ? { product, qty: entry.qty } : null;
      })
      .filter(Boolean);
  }, [cart, products]);

  const cartCount = cartItems.reduce((sum, i) => sum + i.qty, 0);
  const cartSubtotal = cartItems.reduce((sum, i) => sum + i.product.price * i.qty, 0);

  const addToCart = useCallback((product, qty = 1) => {
    const stock = Number(product.stock ?? Infinity);
    if (stock <= 0) return;
    setCart((prev) => {
      const existing = prev.find((e) => e.productId === product.id);
      const currentQty = existing ? existing.qty : 0;
      const nextQty = Math.min(stock, currentQty + qty);
      if (existing) {
        return prev.map((e) => e.productId === product.id ? { ...e, qty: nextQty } : e);
      }
      return [...prev, { productId: product.id, qty: nextQty }];
    });
    showToast(t("product.addToBag") + " ✓ " + L(product.name, lang));
  }, [showToast, t, lang]);

  const updateCartQty = useCallback((productId, qty) => {
    setCart((prev) => {
      if (qty <= 0) return prev.filter((e) => e.productId !== productId);
      return prev.map((e) => e.productId === productId ? { ...e, qty } : e);
    });
  }, []);

  const removeFromCart = useCallback((productId) => {
    setCart((prev) => prev.filter((e) => e.productId !== productId));
  }, []);

  const clearCart = useCallback(() => setCart([]), []);

  /* ---- product CRUD ---- */
  const persistProducts = useCallback((next) => {
    setProducts(next);
    storageSet(STORAGE_KEYS.PRODUCTS, next, true);
  }, []);

  const addProduct = useCallback((data) => {
    const newProduct = { id: uid(), date_added: new Date().toISOString().slice(0, 10), lowStockThreshold: DEFAULT_LOW_STOCK_THRESHOLD, ...data };
    persistProducts([newProduct, ...products]);
    showToast(t("common.add") + " ✓");
  }, [products, persistProducts, showToast, t]);

  const updateProduct = useCallback((id, data) => {
    persistProducts(products.map((p) => (p.id === id ? { ...p, ...data } : p)));
    showToast(t("common.update") + " ✓");
  }, [products, persistProducts, showToast, t]);

  const deleteProduct = useCallback((id) => {
    persistProducts(products.filter((p) => p.id !== id));
    setCart((prev) => prev.filter((e) => e.productId !== id));
    showToast(t("common.delete") + " ✓");
  }, [products, persistProducts, showToast, t]);

  const adjustStock = useCallback((id, delta) => {
    const target = products.find((p) => p.id === id);
    if (!target) return;
    const nextStock = Math.max(0, Number(target.stock || 0) + delta);
    persistProducts(products.map((p) => (p.id === id ? { ...p, stock: nextStock } : p)));
    showToast(t("inventory.stockUpdated"));
  }, [products, persistProducts, showToast, t]);

  /* ---- orders ---- */
  const persistOrders = useCallback((next) => {
    setOrders(next);
    storageSet(STORAGE_KEYS.ORDERS, next, true);
  }, []);

  const placeOrder = useCallback((orderDraft) => {
    const orderId = `PHX-${Date.now().toString(36).toUpperCase()}`;
    const newOrder = { ...orderDraft, id: orderId, status: "pending", createdAt: new Date().toISOString() };
    persistOrders([newOrder, ...orders]);
    // decrement stock for purchased items
    const nextProducts = products.map((p) => {
      const line = orderDraft.items.find((i) => i.productId === p.id);
      if (!line) return p;
      return { ...p, stock: Math.max(0, Number(p.stock || 0) - line.qty) };
    });
    persistProducts(nextProducts);
    // record coupon usage
    if (orderDraft.couponCode) {
      const nextCoupons = coupons.map((c) => c.code.toUpperCase() === orderDraft.couponCode.toUpperCase()
        ? { ...c, timesUsed: Number(c.timesUsed || 0) + 1 } : c);
      setCoupons(nextCoupons);
      storageSet(STORAGE_KEYS.COUPONS, nextCoupons, true);
    }
    clearCart();
    return newOrder;
  }, [orders, persistOrders, products, persistProducts, coupons, clearCart]);

  const updateOrderStatus = useCallback((id, status) => {
    const next = orders.map((o) => (o.id === id ? { ...o, status } : o));
    persistOrders(next);
  }, [orders, persistOrders]);

  /* ---- coupons ---- */
  const persistCoupons = useCallback((next) => {
    setCoupons(next);
    storageSet(STORAGE_KEYS.COUPONS, next, true);
  }, []);

  const addCoupon = useCallback((data) => {
    const newCoupon = { id: uid(), timesUsed: 0, ...data };
    persistCoupons([newCoupon, ...coupons]);
    showToast(t("common.add") + " ✓");
  }, [coupons, persistCoupons, showToast, t]);

  const updateCoupon = useCallback((id, data) => {
    persistCoupons(coupons.map((c) => (c.id === id ? { ...c, ...data } : c)));
    showToast(t("common.update") + " ✓");
  }, [coupons, persistCoupons, showToast, t]);

  const deleteCoupon = useCallback((id) => {
    persistCoupons(coupons.filter((c) => c.id !== id));
    showToast(t("common.delete") + " ✓");
  }, [coupons, persistCoupons, showToast, t]);

  /* ---- settings ---- */
  const updateSettings = useCallback((data) => {
    const next = { ...settings, ...data };
    setSettings(next);
    storageSet(STORAGE_KEYS.SETTINGS, next, true);
  }, [settings]);

  /* ---- admin auth ---- */
  const setupAdmin = useCallback((password) => {
    const config = { password };
    setAdminConfig(config);
    storageSet(STORAGE_KEYS.ADMIN_CONFIG, config, true);
    setIsAdmin(true);
    storageSet(STORAGE_KEYS.ADMIN_SESSION, true, false);
    navigate("admin-dashboard");
  }, [navigate]);

  const loginAdmin = useCallback((password) => {
    if (adminConfig && password === adminConfig.password) {
      setIsAdmin(true);
      storageSet(STORAGE_KEYS.ADMIN_SESSION, true, false);
      navigate("admin-dashboard");
      return true;
    }
    return false;
  }, [adminConfig, navigate]);

  const logoutAdmin = useCallback(() => {
    setIsAdmin(false);
    storageSet(STORAGE_KEYS.ADMIN_SESSION, false, false);
    navigate("home");
  }, [navigate]);

  const changeAdminPassword = useCallback((newPassword) => {
    const config = { password: newPassword };
    setAdminConfig(config);
    storageSet(STORAGE_KEYS.ADMIN_CONFIG, config, true);
  }, []);

  if (!ready) {
    return (
      <div className="phx-root">
        <GlobalStyles />
        <div className="phx-loading-screen">
          <Loader2 size={26} className="phx-spin" />
          <span>{translations[FALLBACK_LANG].common.loading}</span>
        </div>
      </div>
    );
  }

  const selectedProduct = view.page === "product" ? products.find((p) => p.id === view.productId) : null;
  const adminPage = ["admin-login", "admin-dashboard"].includes(view.page);

  return (
    <I18nContext.Provider value={i18nValue}>
    <div className="phx-root">
      <GlobalStyles />
      <Header
        page={view.page}
        cartCount={cartCount}
        isAdmin={isAdmin}
        onNavigate={navigate}
        onOpenCart={() => setCartOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
      />

      {view.page === "home" && (
        <HomePage products={products} onNavigate={navigate} onSelectProduct={selectProduct} onQuickAdd={(p) => addToCart(p, 1)} />
      )}

      {view.page === "catalog" && (
        <CatalogPage
          products={products}
          initialCategory={view.category}
          initialQuery={view.query}
          onSelectProduct={selectProduct}
          onQuickAdd={(p) => addToCart(p, 1)}
        />
      )}

      {view.page === "product" && (
        <ProductPage
          product={selectedProduct}
          allProducts={products}
          onNavigate={navigate}
          onSelectProduct={selectProduct}
          onAddToCart={addToCart}
        />
      )}

      {view.page === "cart" && (
        <CartPage items={cartItems} subtotal={cartSubtotal} onNavigate={navigate} onUpdateQty={updateCartQty} onRemove={removeFromCart} />
      )}

      {view.page === "checkout" && (
        <CheckoutPage items={cartItems} subtotal={cartSubtotal} coupons={coupons} onNavigate={navigate} onPlaceOrder={placeOrder} />
      )}

      {view.page === "about" && <AboutPage onNavigate={navigate} />}

      {view.page === "admin-login" && !isAdmin && (
        <AdminLoginPage adminConfig={adminConfig} onSetup={setupAdmin} onLogin={loginAdmin} onNavigate={navigate} />
      )}
      {view.page === "admin-login" && isAdmin && (
        <AdminDashboard
          products={products}
          orders={orders}
          coupons={coupons}
          settings={settings}
          adminConfig={adminConfig}
          onAddProduct={addProduct}
          onUpdateProduct={updateProduct}
          onDeleteProduct={deleteProduct}
          onAdjustStock={adjustStock}
          onUpdateOrderStatus={updateOrderStatus}
          onAddCoupon={addCoupon}
          onUpdateCoupon={updateCoupon}
          onDeleteCoupon={deleteCoupon}
          onUpdateSettings={updateSettings}
          onChangePassword={changeAdminPassword}
          onLogout={logoutAdmin}
        />
      )}

      {view.page === "admin-dashboard" && !isAdmin && (
        <AdminLoginPage adminConfig={adminConfig} onSetup={setupAdmin} onLogin={loginAdmin} onNavigate={navigate} />
      )}
      {view.page === "admin-dashboard" && isAdmin && (
        <AdminDashboard
          products={products}
          orders={orders}
          coupons={coupons}
          settings={settings}
          adminConfig={adminConfig}
          onAddProduct={addProduct}
          onUpdateProduct={updateProduct}
          onDeleteProduct={deleteProduct}
          onAdjustStock={adjustStock}
          onUpdateOrderStatus={updateOrderStatus}
          onAddCoupon={addCoupon}
          onUpdateCoupon={updateCoupon}
          onDeleteCoupon={deleteCoupon}
          onUpdateSettings={updateSettings}
          onChangePassword={changeAdminPassword}
          onLogout={logoutAdmin}
        />
      )}

      {!adminPage && <Footer onNavigate={navigate} />}

      {cartOpen && (
        <CartDrawer
          items={cartItems}
          subtotal={cartSubtotal}
          onClose={() => setCartOpen(false)}
          onUpdateQty={updateCartQty}
          onRemove={removeFromCart}
          onNavigate={navigate}
        />
      )}

      {searchOpen && (
        <SearchOverlay
          initialQuery=""
          onSearch={(q) => navigate("catalog", { query: q })}
          onClose={() => setSearchOpen(false)}
        />
      )}

      <Toast toast={toast} />
    </div>
    </I18nContext.Provider>
  );
}
