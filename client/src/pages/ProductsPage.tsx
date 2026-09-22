import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut, decimalDisplay, errorMessage, financialValue, money, shortDate } from "../api";
import { Card, Modal, PageHeader } from "../components";
import type { ComboDiscount, Customer, Product, Rate, RateTier } from "../types";

interface TierRow {
  upTo: string;
  unitPrice: string;
  floor: string;
  ceiling: string;
}

interface RateEditor {
  rateId: string;
  productName: string;
  unitPrice: string;
  tiers: TierRow[];
}

function tierLabel(tier: RateTier | { upTo: string | null; unitPrice: string; floor?: string | null; ceiling?: string | null }): string {
  const bound = tier.upTo === null ? "beyond" : `≤ ${tier.upTo}`;
  const extras = [
    tier.floor != null ? `min ${money(tier.floor)}` : null,
    tier.ceiling != null ? `cap ${money(tier.ceiling)}` : null,
  ].filter(Boolean);
  return `${bound} @ ${money(tier.unitPrice)}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

export function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<string>("");
  const [rates, setRates] = useState<Rate[]>([]);
  const [combos, setCombos] = useState<ComboDiscount[]>([]);
  const [editor, setEditor] = useState<RateEditor | null>(null);
  const [comboForm, setComboForm] = useState({
    name: "",
    productIds: [] as string[],
    percentOff: "",
    scope: "customer",
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Product[]>("/products")
      .then(setProducts)
      .catch((error) => setError(errorMessage(error)));
    apiGet<Customer[]>("/customers")
      .then((rows) => {
        setCustomers(rows);
        if (rows.length > 0) setCustomerId(rows[0].id);
      })
      .catch((error) => setError(errorMessage(error)));
  }, []);

  const customer = customers.find((row) => row.id === customerId);

  const loadRates = useCallback((cid: string) => {
    if (!cid) return;
    apiGet<Rate[]>(`/rates?customerId=${cid}`)
      .then(setRates)
      .catch((error) => setError(errorMessage(error)));
    apiGet<ComboDiscount[]>(`/rates/combos?customerId=${cid}`)
      .then(setCombos)
      .catch((error) => setError(errorMessage(error)));
  }, []);
  useEffect(() => loadRates(customerId), [customerId, loadRates]);

  const openEditor = (rate: Rate) => {
    setEditor({
      rateId: rate.id,
      productName: rate.productName ?? "",
      unitPrice: rate.unitPriceDecimal ?? String(rate.unitPrice),
      tiers: (rate.tiersDecimal ?? rate.tiers).map((tier) => ({
        upTo: tier.upTo === null ? "" : String(tier.upTo),
        unitPrice: String(tier.unitPrice),
        floor: tier.floor != null ? String(tier.floor) : "",
        ceiling: tier.ceiling != null ? String(tier.ceiling) : "",
      })),
    });
  };

  const saveEditor = async () => {
    if (!editor) return;
    setError(null);
    try {
      const tiers = editor.tiers
        .filter((row) => row.unitPrice !== "")
        .map((row) => ({
          upTo: row.upTo === "" ? null : row.upTo,
          unitPrice: row.unitPrice,
          floor: row.floor === "" ? null : row.floor,
          ceiling: row.ceiling === "" ? null : row.ceiling,
        }));
      await apiPut(`/rates/${editor.rateId}`, {
        unitPrice: editor.unitPrice,
        tiers,
      });
      setEditor(null);
      loadRates(customerId);
    } catch (error) {
      setError(errorMessage(error));
    }
  };

  const setTierField = (index: number, field: keyof TierRow, value: string) => {
    if (!editor) return;
    const tiers = editor.tiers.map((row, i) => (i === index ? { ...row, [field]: value } : row));
    setEditor({ ...editor, tiers });
  };

  const addCombo = async () => {
    setError(null);
    try {
      await apiPost("/rates/combos", {
        name: comboForm.name,
        productIds: comboForm.productIds,
        percentOff: comboForm.percentOff,
        customerId: comboForm.scope === "global" ? null : customerId,
      });
      setComboForm({ name: "", productIds: [], percentOff: "", scope: "customer" });
      loadRates(customerId);
    } catch (error) {
      setError(errorMessage(error));
    }
  };

  return (
    <div>
      <PageHeader
        title="Products & Pricing"
        subtitle="The catalog, and each customer's negotiated rate agreement."
      />
      {error && <div className="banner error">{error}</div>}

      <Card title="Catalog" flush>
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Product</th>
              <th>Unit</th>
              <th className="num">List price</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                <td className="strong">{product.sku}</td>
                <td>{product.name}</td>
                <td className="muted">{product.unit}</td>
                <td className="num">{money(financialValue(product.listPriceDecimal, product.listPrice))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Rate agreement"
        actions={
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            {customers.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        }
        flush
      >
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">Base price</th>
              <th>Quantity intervals</th>
              <th>Effective</th>
              <th className="num"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => (
              <tr key={rate.id}>
                <td className="strong">
                  {rate.productName} <span className="muted">({rate.productSku})</span>
                </td>
                <td className="num">{money(financialValue(rate.unitPriceDecimal, rate.unitPrice))}</td>
                <td className="muted">
                  {(rate.tiersDecimal ?? rate.tiers).length > 0
                    ? (rate.tiersDecimal ?? rate.tiers)
                        .toSorted(
                          (a, b) => Number(a.upTo ?? Infinity) - Number(b.upTo ?? Infinity)
                        )
                        .map(tierLabel)
                        .join(" · ")
                    : "Flat rate"}
                </td>
                <td>{shortDate(rate.effectiveDate)}</td>
                <td className="num">
                  <button className="btn sm" onClick={() => openEditor(rate)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Combo discounts" flush>
        <table>
          <thead>
            <tr>
              <th>Combo</th>
              <th>Products</th>
              <th>Scope</th>
              <th className="num">Discount</th>
            </tr>
          </thead>
          <tbody>
            {combos.map((combo) => (
              <tr key={combo.id}>
                <td className="strong">{combo.name}</td>
                <td className="muted">{combo.products.map((p) => p.sku).join(" + ")}</td>
                <td>
                  {combo.customerId === null ? (
                    <span className="badge">Global</span>
                  ) : (
                    customer?.name
                  )}
                </td>
                <td className="num">
                  {decimalDisplay(combo.percentOffDecimal ?? combo.percentOff)}% off
                </td>
              </tr>
            ))}
            {combos.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No combo discounts apply to this customer.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="totals" style={{ borderRadius: "0 0 10px 10px" }}>
          <div className="field-grid">
            <label className="field">
              <span>Name</span>
              <input
                placeholder="e.g. Platform Bundle"
                value={comboForm.name}
                onChange={(e) => setComboForm({ ...comboForm, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Products (⌘-click for multiple)</span>
              <select
                multiple
                size={4}
                value={comboForm.productIds}
                onChange={(e) =>
                  setComboForm({
                    ...comboForm,
                    productIds: [...e.target.selectedOptions].map((option) => option.value),
                  })
                }
              >
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} — {product.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>% off</span>
              <input
                className="qty"
                type="number"
                step="0.5"
                value={comboForm.percentOff}
                onChange={(e) => setComboForm({ ...comboForm, percentOff: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Scope</span>
              <select
                value={comboForm.scope}
                onChange={(e) => setComboForm({ ...comboForm, scope: e.target.value })}
              >
                <option value="customer">{customer?.name ?? "This customer"}</option>
                <option value="global">Global — all customers</option>
              </select>
            </label>
            <div className="field">
              <span>&nbsp;</span>
              <div>
                <button
                  className="btn"
                  disabled={
                    !comboForm.name || comboForm.productIds.length < 2 || !comboForm.percentOff
                  }
                  onClick={addCombo}
                >
                  Add combo
                </button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {editor && (
        <Modal
          title={`Edit rate — ${editor.productName}`}
          onClose={() => setEditor(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEditor(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!editor.unitPrice} onClick={saveEditor}>
                Save rate
              </button>
            </>
          }
        >
          <div className="field-grid" style={{ marginBottom: 4 }}>
            <label className="field">
              <span>Base price (used when no intervals are defined)</span>
              <input
                className="qty"
                type="number"
                step="0.01"
                value={editor.unitPrice}
                onChange={(e) => setEditor({ ...editor, unitPrice: e.target.value })}
              />
            </label>
          </div>

          <div className="modal-section">Quantity intervals</div>
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            Units inside each interval bill at its price; the interval charge is clamped
            between its floor and ceiling. The line's price is the blended result. Leave
            "Up to" blank for the final, unbounded interval.
          </p>
          <table>
            <thead>
              <tr>
                <th className="num">Up to qty</th>
                <th className="num">Unit price</th>
                <th className="num">Floor</th>
                <th className="num">Ceiling</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {editor.tiers.map((row, index) => (
                <tr key={index}>
                  <td className="num">
                    <input
                      aria-label={`Upper quantity bound for tier ${index + 1}`}
                      className="qty"
                      type="number"
                      placeholder="∞"
                      value={row.upTo}
                      onChange={(e) => setTierField(index, "upTo", e.target.value)}
                    />
                  </td>
                  <td className="num">
                    <input
                      aria-label={`Unit price for tier ${index + 1}`}
                      className="qty"
                      type="number"
                      step="0.01"
                      value={row.unitPrice}
                      onChange={(e) => setTierField(index, "unitPrice", e.target.value)}
                    />
                  </td>
                  <td className="num">
                    <input
                      aria-label={`Floor for tier ${index + 1}`}
                      className="qty"
                      type="number"
                      placeholder="—"
                      value={row.floor}
                      onChange={(e) => setTierField(index, "floor", e.target.value)}
                    />
                  </td>
                  <td className="num">
                    <input
                      aria-label={`Ceiling for tier ${index + 1}`}
                      className="qty"
                      type="number"
                      placeholder="—"
                      value={row.ceiling}
                      onChange={(e) => setTierField(index, "ceiling", e.target.value)}
                    />
                  </td>
                  <td className="num">
                    <button
                      className="btn sm"
                      onClick={() =>
                        setEditor({
                          ...editor,
                          tiers: editor.tiers.filter((_, i) => i !== index),
                        })
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {editor.tiers.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No intervals — the flat base price applies.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div style={{ marginTop: 10 }}>
            <button
              className="btn sm"
              onClick={() =>
                setEditor({
                  ...editor,
                  tiers: [...editor.tiers, { upTo: "", unitPrice: "", floor: "", ceiling: "" }],
                })
              }
            >
              Add interval
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
