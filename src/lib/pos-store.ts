import { Customer, OrderPayload, OrderUpdatePayload, Product, ProductInput, SavedOrder, Waiter } from '@/lib/pos-types';

const products: Product[] = [
  { id: 1, name: 'Fresh Avocado', price: 420, stock: 45, category: 'Groceries', variation: '2 pcs pack', image: '/products/fresh-avocado.svg', color: 'bg-green-50', description: 'Creamy fresh avocados for salads, toast, and bowls.' },
  { id: 2, name: 'Organic Milk', price: 280, stock: 18, category: 'Beverages', variation: '1 litre', image: '/products/organic-milk.svg', color: 'bg-sky-50', description: 'Farm-fresh organic milk for home and cafe service.' },
  { id: 3, name: 'Dark Chocolate', price: 350, stock: 32, category: 'Snacks', variation: '100 g bar', image: '/products/dark-chocolate.svg', color: 'bg-amber-50', description: 'Rich dark chocolate bar for impulse and premium sales.' },
  { id: 4, name: 'Coffee Beans', price: 1250, stock: 11, category: 'Beverages', variation: '500 g bag', image: '/products/coffee-beans.svg', color: 'bg-orange-50', description: 'Roasted coffee beans with a balanced medium-dark profile.' },
  { id: 5, name: 'Red Apple', price: 180, stock: 90, category: 'Groceries', variation: '1 kg', image: '/products/red-apple.svg', color: 'bg-rose-50', description: 'Crisp apples packed for daily fruit sales.' },
  { id: 6, name: 'Whole Grain Bread', price: 240, stock: 24, category: 'Bakery', variation: '1 loaf', image: '/products/whole-grain-bread.svg', color: 'bg-yellow-50', description: 'Soft whole grain bread baked for breakfast and sandwiches.' },
  { id: 7, name: 'Sparkling Water', price: 150, stock: 54, category: 'Beverages', variation: '500 ml', image: '/products/sparkling-water.svg', color: 'bg-cyan-50', description: 'Chilled sparkling water for dine-in and takeaway orders.' },
  { id: 8, name: 'Butter Croissant', price: 190, stock: 16, category: 'Bakery', variation: 'Single piece', image: '/products/butter-croissant.svg', color: 'bg-orange-50', description: 'Flaky croissant ready for counter display and quick service.' },
  { id: 9, name: 'Chicken Tikka Pizza', price: 1590, stock: 20, category: 'Pizza', variation: 'Large', image: '/products/chicken-tikka-pizza.svg', color: 'bg-rose-50', description: 'Spiced chicken tikka pizza with mozzarella and green peppers.' },
  { id: 10, name: 'Zinger Shawarma', price: 540, stock: 28, category: 'Shawarma', variation: 'Single wrap', image: '/products/zinger-shawarma.svg', color: 'bg-yellow-50', description: 'Crispy chicken shawarma with garlic mayo and lettuce.' },
  { id: 11, name: 'Malai Boti Paratha Roll', price: 590, stock: 22, category: 'Paratha Roll', variation: 'Single roll', image: '/products/malai-boti-roll.svg', color: 'bg-amber-50', description: 'Soft paratha roll packed with malai boti and mint sauce.' },
  { id: 12, name: 'Family Deal 1', price: 2490, stock: 12, category: 'Deals', variation: 'Serves 4', image: '/products/family-deal.svg', color: 'bg-lime-50', description: 'Family combo with pizza, fries, drinks, and dipping sauces.' },
  { id: 13, name: 'Beef Burger Combo', price: 780, stock: 18, category: 'Deals', variation: 'Burger + fries + drink', image: '/products/beef-burger-combo.svg', color: 'bg-orange-50', description: 'Branch combo meal built for lunch and evening rush.' },
];

const customers: Customer[] = [
  { id: 'cus-101', name: 'Ayesha Khan', phone: '03001234567', address: 'Johar Town, Lahore', previousDues: 0 },
  { id: 'cus-102', name: 'Bilal Ahmed', phone: '03007654321', address: 'Model Town, Lahore', previousDues: 1250 },
  { id: 'cus-103', name: 'Sana Malik', phone: '03112223334', address: 'DHA Phase 4, Lahore', previousDues: 0 },
];

const waiters: Waiter[] = [
  { id: 'wait-101', name: 'Fariha', isActive: true },
  { id: 'wait-102', name: 'Ahsan Raza', isActive: true },
  { id: 'wait-103', name: 'Rehman', isActive: true },
  { id: 'wait-104', name: 'Rehan', isActive: true },
];

const orders: SavedOrder[] = [
  {
    id: 'ord-1001',
    items: [
      { name: 'Coffee Beans', price: 1250, quantity: 1, variation: '500 g bag' },
      { name: 'Butter Croissant', price: 190, quantity: 2, variation: 'Single piece' },
    ],
    subtotal: 1630,
    tax: 0,
    total: 1630,
    orderType: 'Delivery',
    customer: { name: 'Bilal Ahmed', phone: '03007654321', address: 'Model Town, Lahore' },
    address: 'Model Town, Lahore',
    note: 'Call on arrival',
    waiter: '',
    table: '',
    status: 'pending',
    paymentMethod: 'Cash',
    createdAt: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
    paidAmount: 0,
    remainingAmount: 1630,
    discount: null,
  },
  {
    id: 'ord-1002',
    items: [
      { name: 'Sparkling Water', price: 150, quantity: 2, variation: '500 ml' },
      { name: 'Dark Chocolate', price: 350, quantity: 1, variation: '100 g bar' },
    ],
    subtotal: 650,
    tax: 0,
    total: 650,
    orderType: 'DineIn',
    customer: { name: 'Dine-In Customer', phone: '03000000000', address: '' },
    address: '',
    note: 'Serve together',
    waiter: 'Fariha',
    table: '4',
    status: 'pending',
    paymentMethod: 'Card',
    createdAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
    paidAmount: 0,
    remainingAmount: 650,
    discount: null,
  },
  {
    id: 'ord-1003',
    items: [
      { name: 'Organic Milk', price: 280, quantity: 2, variation: '1 litre' },
      { name: 'Whole Grain Bread', price: 240, quantity: 1, variation: '1 loaf' },
    ],
    subtotal: 800,
    tax: 0,
    total: 800,
    orderType: 'TakeAway',
    customer: { name: 'Sana Malik', phone: '03112223334', address: 'DHA Phase 4, Lahore' },
    address: 'DHA Phase 4, Lahore',
    note: '',
    waiter: 'Rehan',
    table: '',
    status: 'completed',
    paymentMethod: 'Cash',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    paidAmount: 800,
    remainingAmount: 0,
    discount: null,
  },
];

export function getProducts() {
  return products;
}

export function getProduct(id: number) {
  return products.find((product) => product.id === id) ?? null;
}

export function createProduct(input: ProductInput) {
  const product: Product = {
    id: Date.now(),
    ...input,
  };

  products.unshift(product);
  return product;
}

export function updateProduct(id: number, patch: Partial<ProductInput>) {
  const product = products.find((entry) => entry.id === id);
  if (!product) return null;
  Object.assign(product, patch);
  return product;
}

export function getCategories() {
  return ['All', ...new Set(products.map((product) => product.category))];
}

export function searchCustomers(query: string, searchBy: 'name' | 'phone' | 'both' = 'both') {
  const normalized = query.trim().toLowerCase();

  return customers.filter((customer) => {
    const byName = customer.name.toLowerCase().includes(normalized);
    const byPhone = customer.phone.includes(normalized.replace(/\D/g, ''));

    if (searchBy === 'name') return byName;
    if (searchBy === 'phone') return byPhone;
    return byName || byPhone;
  });
}

export function getCustomers() {
  return [...customers].sort((left, right) => left.name.localeCompare(right.name));
}

export function updateCustomer(id: string, patch: Partial<Customer>) {
  const customer = customers.find((entry) => entry.id === id);
  if (!customer) return null;
  Object.assign(customer, patch);
  return customer;
}

export function createCustomer(input: Omit<Customer, 'id'>) {
  const customer: Customer = {
    id: `cus-${Date.now()}`,
    ...input,
  };

  customers.unshift(customer);
  return customer;
}

export function updateCustomerDuesByPhone(phone: string, previousDues: number) {
  const normalizedPhone = phone.replace(/\D/g, '');
  const customer = customers.find((entry) => entry.phone.replace(/\D/g, '') === normalizedPhone);
  if (!customer) return null;
  customer.previousDues = previousDues;
  return customer;
}

export function getWaiters() {
  return [...waiters].sort((left, right) => left.name.localeCompare(right.name));
}

export function createWaiter(input: { name: string; isActive?: boolean }) {
  const waiter: Waiter = {
    id: `wait-${Date.now()}`,
    name: input.name,
    isActive: input.isActive ?? true,
  };

  waiters.unshift(waiter);
  return waiter;
}

export function updateWaiter(id: string, patch: Partial<Pick<Waiter, 'name' | 'isActive'>>) {
  const waiter = waiters.find((entry) => entry.id === id);
  if (!waiter) return null;
  Object.assign(waiter, patch);
  return waiter;
}

export function deleteWaiter(id: string) {
  const index = waiters.findIndex((entry) => entry.id === id);
  if (index === -1) return false;
  waiters.splice(index, 1);
  return true;
}

export function checkPendingOrder(phone: string) {
  const normalizedPhone = phone.replace(/\D/g, '');
  return orders.some((order) => order.status === 'pending' && order.customer.phone === normalizedPhone);
}

export function createOrder(payload: OrderPayload) {
  const existingCustomer = customers.find((customer) => customer.phone === payload.customer.phone);

  // This mirrors your older app flow: known customers get refreshed, and new phones create a saved customer.
  if (existingCustomer) {
    existingCustomer.name = payload.customer.name;
    existingCustomer.address = payload.customer.address;
  } else if (payload.customer.phone && payload.customer.phone !== '03000000000') {
    customers.unshift({
      id: `cus-${Date.now()}`,
      name: payload.customer.name,
      phone: payload.customer.phone,
      address: payload.customer.address,
      previousDues: 0,
    });
  }

  const savedOrder: SavedOrder = {
    id: `ord-${Date.now()}`,
    ...payload,
    paidAmount: payload.paidAmount ?? 0,
    remainingAmount: payload.remainingAmount ?? payload.total,
    discount: payload.discount ?? null,
  };

  orders.unshift(savedOrder);
  return savedOrder;
}

export function getOrders(date?: string) {
  const snapshot = [...orders].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  if (!date) {
    return snapshot;
  }

  return snapshot.filter((order) => order.createdAt.slice(0, 10) === date);
}

export function getOrder(id: string) {
  return orders.find((order) => order.id === id) ?? null;
}

export function updateOrder(id: string, patch: OrderUpdatePayload) {
  const order = orders.find((entry) => entry.id === id);
  if (!order) return null;

  if (patch.action === 'addItems' && patch.items?.length) {
    // This supports the old "split order / add items" flow by appending more items to the same ticket.
    order.items = [...order.items, ...patch.items];
    const addedSubtotal = patch.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    order.subtotal += addedSubtotal;
    order.tax = 0;
    order.total += addedSubtotal;
    order.remainingAmount = Math.max((order.remainingAmount ?? order.total) + addedSubtotal, 0);
  }

  if (patch.action === 'replaceItems' && patch.items) {
    order.items = patch.items;
    order.subtotal = patch.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    order.tax = 0;
    order.total = order.subtotal;
    order.remainingAmount = Math.max(order.total - (order.paidAmount ?? 0), 0);
  }

  if (patch.status) order.status = patch.status;
  if (patch.note !== undefined) order.note = patch.note;
  if (patch.waiter !== undefined) order.waiter = patch.waiter;
  if (patch.table !== undefined) order.table = patch.table;
  if (patch.paymentMethod) order.paymentMethod = patch.paymentMethod;
  if (patch.customer) order.customer = patch.customer;
  if (patch.address !== undefined) order.address = patch.address;
  if (typeof patch.paidAmount === 'number') order.paidAmount = patch.paidAmount;
  if (typeof patch.remainingAmount === 'number') order.remainingAmount = patch.remainingAmount;
  if (patch.discount !== undefined) order.discount = patch.discount;
  if (patch.cancelledAt) order.cancelledAt = patch.cancelledAt;
  if (patch.cancelledBy) order.cancelledBy = patch.cancelledBy;
  if (patch.cancelReason) order.cancelReason = patch.cancelReason;

  return order;
}
