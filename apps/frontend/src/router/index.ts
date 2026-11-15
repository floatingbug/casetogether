import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  type Router,
  type RouterHistory,
  type RouteRecordRaw,
} from 'vue-router';
import LobbyView from '../views/LobbyView.vue';
import LoginView from '../views/LoginView.vue';
import NotFoundView from '../views/NotFoundView.vue';
import RegisterView from '../views/RegisterView.vue';
import { useAuthStore } from '../stores/auth';
import { safeInternalPath } from './navigation';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'lobby',
    component: LobbyView,
    meta: { requiresAuth: true },
  },
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { guestOnly: true },
  },
  {
    path: '/register',
    name: 'register',
    component: RegisterView,
    meta: { guestOnly: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: NotFoundView,
  },
];

export function createAppRouter(history?: RouterHistory): Router {
  const router = createRouter({
    history: history ?? createWebHistory(),
    routes,
    scrollBehavior: () => ({ top: 0 }),
  });

  router.beforeEach(async (to) => {
    const auth = useAuthStore();
    await auth.bootstrap();

    if (to.meta['requiresAuth'] === true && !auth.isAuthenticated) {
      return {
        name: 'login',
        query: { redirect: safeInternalPath(to.path) },
      };
    }

    if (to.meta['guestOnly'] === true && auth.isAuthenticated) {
      return { name: 'lobby' };
    }

    return true;
  });

  return router;
}

export { createMemoryHistory };
