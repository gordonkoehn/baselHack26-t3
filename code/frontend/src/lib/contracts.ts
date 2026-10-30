// API contracts. Mirror of code/shared/schema.json — change that file first, then this one and code/backend/app/contracts.py.

export type Item = {
  id: string;
  title: string;
  done: boolean;
};

export type ItemCreate = {
  title: string;
};
