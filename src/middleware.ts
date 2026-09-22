import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isRrrOnlySection, loginIdFromEmail, RRR_ONLY_IDS } from '@/app/login/accounts';

/**
 * Refreshes the Supabase session on every request and gates the app behind a
 * login. Role-based routing happens in the layout, where the user's role is
 * read from the database — not from the JWT, which the client could tamper with.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;

  if (!user && pathname !== '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  if (user && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  if (user && pathname !== '/login') {
    const loginId = loginIdFromEmail(user.email);
    const { data: profile } = await supabase.from('users').select('role, is_active')
      .eq('id', user.id).single();
    if (profile?.is_active && loginId && RRR_ONLY_IDS.includes(loginId)
      && !isRrrOnlySection(pathname)) {
      const url = request.nextUrl.clone();
      url.pathname = '/rrr';
      url.search = '';
      return NextResponse.redirect(url);
    }
    if (profile?.is_active && ['sales_exec', 'sales_manager'].includes(profile.role)
      && pathname !== '/rrr/my' && !pathname.startsWith('/rrr/my/')) {
      const url = request.nextUrl.clone();
      url.pathname = '/rrr/my';
      url.search = '';
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|webp)$).*)'],
};
