import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001',
  // LLM generation can take 30s+ on free-tier models
  timeout: 90_000,
});

// Normalize error messages so callers always get a plain Error with a readable message
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const message =
      err.response?.data?.message ||
      err.response?.data?.error ||
      err.message ||
      'Request failed';
    return Promise.reject(new Error(message));
  },
);

export default api;
