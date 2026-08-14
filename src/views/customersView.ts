import { Router } from "express";
import * as customers from "../controllers/customerController";
import { h } from "./helpers";

export const customersView = Router();

customersView.get("/", h(async () => customers.listCustomers()));
