import { getAuthToken, request } from './http';

export interface StoreService {
  id: number;
  name: string;
  price: string;
  imageId: number | null;
  status: 'enabled' | 'disabled' | 'deleted';
  creatorName: string;
  createdAt: string;
}
export const servicePath = '/admin/store-services';
export function formatServicePrice(value: string) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  return match ? match[1].replace(/^0+(?=\d)/, '') + '.' + (match[2] ?? '').padEnd(2, '0') : null;
}
export async function loadServiceImage(service: StoreService) {
  const base = import.meta.env.VITE_API_BASE_URL ?? '/api';
  const response = await fetch(base + servicePath + '/' + service.id + '/images/' + service.imageId, {
    headers: { Authorization: 'Bearer ' + getAuthToken() },
  });
  if (!response.ok) throw new Error('服务主图读取失败');
  return URL.createObjectURL(await response.blob());
}
export const listServices = () => request<StoreService[]>(servicePath);
export const readService = (id: number) => request<StoreService>(servicePath + '/' + id);
