import { icons } from "./components";
import { navigate, useRoute } from "./router";
import { CashApplicationPage } from "./pages/CashApplicationPage";
import { InvoiceDetailPage } from "./pages/InvoiceDetailPage";
import { InvoicesPage } from "./pages/InvoicesPage";
import { OrderDetailPage } from "./pages/OrderDetailPage";
import { OrdersPage } from "./pages/OrdersPage";
import { ProductsPage } from "./pages/ProductsPage";
import { ReportsPage } from "./pages/ReportsPage";

const NAV = [
  {
    section: "Order to Cash",
    items: [
      { path: "/orders", label: "Orders", icon: icons.orders },
      { path: "/invoices", label: "Invoices", icon: icons.invoices },
      { path: "/cash-application", label: "Cash Application", icon: icons.cash },
    ],
  },
  {
    section: "Catalog",
    items: [{ path: "/products", label: "Products & Pricing", icon: icons.products }],
  },
  {
    section: "Insights",
    items: [{ path: "/reports", label: "Reports", icon: icons.reports }],
  },
];

function routePage(path: string) {
  const [, root, id] = path.split("/");
  if (root === "orders" && id) return <OrderDetailPage orderId={id} />;
  if (root === "orders") return <OrdersPage />;
  if (root === "invoices" && id) return <InvoiceDetailPage invoiceId={id} />;
  if (root === "invoices") return <InvoicesPage />;
  if (root === "cash-application") return <CashApplicationPage />;
  if (root === "products") return <ProductsPage />;
  if (root === "reports") return <ReportsPage />;
  return <OrdersPage />;
}

export function App() {
  const path = useRoute();
  const root = "/" + (path.split("/")[1] ?? "orders");

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-name">Meridian</div>
            <div className="brand-sub">Billing &amp; Receivables</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((group) => (
            <div key={group.section}>
              <div className="nav-section">{group.section}</div>
              {group.items.map((item) => (
                <button
                  key={item.path}
                  className={root === item.path ? "nav-item active" : "nav-item"}
                  onClick={() => navigate(item.path)}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="avatar">AR</div>
          <div>
            <div className="user-name">Alex Reyes</div>
            <div className="user-role">Controller</div>
          </div>
        </div>
      </aside>
      <main className="content">{routePage(path)}</main>
    </div>
  );
}
