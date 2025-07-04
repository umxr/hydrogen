import {
  type ReactNode,
  useEffect,
  useState,
  useMemo,
  createContext,
  useContext,
  useRef,
} from 'react';
import {type CartReturn} from '../cart/queries/cart-types';
import {
  AnalyticsPageView,
  AnalyticsProductView,
  AnalyticsCollectionView,
  AnalyticsCartView,
  AnalyticsSearchView,
  AnalyticsCustomView,
  type PageViewPayload,
  type ProductViewPayload,
  type CollectionViewPayload,
  type CartViewPayload,
  type CartUpdatePayload,
  type CustomEventPayload,
  type OtherData,
  type EventPayloads,
  type CartLineUpdatePayload,
  type SearchViewPayload,
} from './AnalyticsView';
import type {
  CurrencyCode,
  LanguageCode,
  Shop,
  Localization,
} from '@shopify/hydrogen-react/storefront-api-types';
import {AnalyticsEvent} from './events';
import {ShopifyAnalytics} from './ShopifyAnalytics';
import {CartAnalytics} from './CartAnalytics';
import {
  type PrivacyBanner,
  getCustomerPrivacy,
  getPrivacyBanner,
  type CustomerPrivacy,
  type CustomerPrivacyApiProps,
} from '../customer-privacy/ShopifyCustomerPrivacy';
import type {Storefront} from '../storefront';
import {PerfKit} from './PerfKit';
import {errorOnce, warnOnce} from '../utils/warning';

export type ShopAnalytics = {
  /** The shop ID. */
  shopId: string;
  /** The language code that is being displayed to user. */
  acceptedLanguage: LanguageCode;
  /** The currency code that is being displayed to user. */
  currency: CurrencyCode;
  /** The Hydrogen subchannel ID generated by Oxygen in the environment variable. */
  hydrogenSubchannelId: string | '0';
};

export type Consent = Partial<
  Pick<
    CustomerPrivacyApiProps,
    'checkoutDomain' | 'storefrontAccessToken' | 'withPrivacyBanner' | 'country'
  >
> & {language?: LanguageCode}; // the privacyBanner SDKs refers to "language" as "locale" :(

export type AnalyticsProviderProps = {
  /** React children to render. */
  children?: ReactNode;
  /** The cart or cart promise to track for cart analytics. When there is a difference between the state of the cart, `AnalyticsProvider` will trigger a `cart_updated` event. It will also produce `product_added_to_cart` and `product_removed_from_cart` based on cart line quantity and cart line id changes. */
  cart: Promise<CartReturn | null> | CartReturn | null;
  /** An optional function to set wether the user can be tracked. Defaults to Customer Privacy API's `window.Shopify.customerPrivacy.analyticsProcessingAllowed()`. */
  canTrack?: () => boolean;
  /** An optional custom payload to pass to all events. e.g language/locale/currency. */
  customData?: Record<string, unknown>;
  /** The shop configuration required to publish analytics events to Shopify. Use [`getShopAnalytics`](/docs/api/hydrogen/2025-04/utilities/getshopanalytics). */
  shop: Promise<ShopAnalytics | null> | ShopAnalytics | null;
  /** The customer privacy consent configuration and options. */
  consent: Consent;
  /** @deprecated Disable throwing errors when required props are missing. */
  disableThrowOnError?: boolean;
  /** The domain scope of the cookie set with `useShopifyCookies`. **/
  cookieDomain?: string;
};

export type Carts = {
  cart: Awaited<AnalyticsProviderProps['cart']>;
  prevCart: Awaited<AnalyticsProviderProps['cart']>;
};

export type AnalyticsContextValue = {
  /** A function to tell you the current state of if the user can be tracked by analytics. Defaults to Customer Privacy API's `window.Shopify.customerPrivacy.analyticsProcessingAllowed()`. */
  canTrack: NonNullable<AnalyticsProviderProps['canTrack']>;
  /** The current cart state. */
  cart: Awaited<AnalyticsProviderProps['cart']>;
  /** The custom data passed in from the `AnalyticsProvider`. */
  customData?: AnalyticsProviderProps['customData'];
  /** The previous cart state. */
  prevCart: Awaited<AnalyticsProviderProps['cart']>;
  /** A function to publish an analytics event. */
  publish: typeof publish;
  /** A function to register with the analytics provider. */
  register: (key: string) => {ready: () => void};
  /** The shop configuration required to publish events to Shopify. */
  shop: Awaited<AnalyticsProviderProps['shop']>;
  /** A function to subscribe to analytics events. */
  subscribe: typeof subscribe;
  /** The privacy banner SDK methods with the config applied */
  privacyBanner: PrivacyBanner | null;
  /** The customer privacy SDK methods with the config applied */
  customerPrivacy: CustomerPrivacy | null;
};

export const defaultAnalyticsContext: AnalyticsContextValue = {
  canTrack: () => false,
  cart: null,
  customData: {},
  prevCart: null,
  publish: () => {},
  shop: null,
  subscribe: () => {},
  register: () => ({ready: () => {}}),
  customerPrivacy: null,
  privacyBanner: null,
};

const AnalyticsContext = createContext<AnalyticsContextValue>(
  defaultAnalyticsContext,
);

const subscribers = new Map<
  string,
  Map<string, (payload: EventPayloads) => void>
>();
const registers: Record<string, boolean> = {};

function areRegistersReady() {
  return Object.values(registers).every(Boolean);
}

// Overload functions for each subscribe event
function subscribe(
  event: typeof AnalyticsEvent.PAGE_VIEWED,
  callback: (payload: PageViewPayload) => void,
): void;

function subscribe(
  event: typeof AnalyticsEvent.PRODUCT_VIEWED,
  callback: (payload: ProductViewPayload) => void,
): void;

function subscribe(
  event: typeof AnalyticsEvent.COLLECTION_VIEWED,
  callback: (payload: CollectionViewPayload) => void,
): void;

function subscribe(
  event: typeof AnalyticsEvent.CART_VIEWED,
  callback: (payload: CartViewPayload) => void,
): void;

function subscribe(
  event: typeof AnalyticsEvent.SEARCH_VIEWED,
  callback: (payload: SearchViewPayload) => void,
): void;

function subscribe(
  event: typeof AnalyticsEvent.CART_UPDATED,
  callback: (payload: CartUpdatePayload) => void,
): void;

function subscribe(
  event: typeof AnalyticsEvent.PRODUCT_ADD_TO_CART,
  callback: (payload: CartLineUpdatePayload) => void,
): void;

function subscribe(
  event: typeof AnalyticsEvent.PRODUCT_REMOVED_FROM_CART,
  callback: (payload: CartLineUpdatePayload) => void,
): void;

function subscribe(
  event: typeof AnalyticsEvent.CUSTOM_EVENT,
  callback: (payload: CustomEventPayload) => void,
): void;

function subscribe(event: any, callback: any) {
  if (!subscribers.has(event)) {
    subscribers.set(event, new Map());
  }
  subscribers.get(event)?.set(callback.toString(), callback);
}

const waitForReadyQueue = new Map<any, any>();

function publish(
  event: typeof AnalyticsEvent.PAGE_VIEWED,
  payload: PageViewPayload,
): void;
function publish(
  event: typeof AnalyticsEvent.PRODUCT_VIEWED,
  payload: ProductViewPayload,
): void;
function publish(
  event: typeof AnalyticsEvent.COLLECTION_VIEWED,
  payload: CollectionViewPayload,
): void;
function publish(
  event: typeof AnalyticsEvent.CART_VIEWED,
  payload: CartViewPayload,
): void;
function publish(
  event: typeof AnalyticsEvent.CART_UPDATED,
  payload: CartUpdatePayload,
): void;
function publish(
  event: typeof AnalyticsEvent.PRODUCT_ADD_TO_CART,
  payload: CartLineUpdatePayload,
): void;
function publish(
  event: typeof AnalyticsEvent.PRODUCT_REMOVED_FROM_CART,
  payload: CartLineUpdatePayload,
): void;
function publish(
  event: typeof AnalyticsEvent.CUSTOM_EVENT,
  payload: OtherData,
): void;
function publish(event: any, payload: any): void {
  if (!areRegistersReady()) {
    waitForReadyQueue.set(event, payload);
    return;
  }

  publishEvent(event, payload);
}

function publishEvent(event: any, payload: any): void {
  (subscribers.get(event) ?? new Map()).forEach((callback, subscriber) => {
    try {
      callback(payload);
    } catch (error) {
      if (typeof error === 'object' && error instanceof Error) {
        console.error(
          'Analytics publish error',
          error.message,
          subscriber,
          error.stack,
        );
      } else {
        console.error('Analytics publish error', error, subscriber);
      }
    }
  });
}

function register(key: string) {
  if (!registers.hasOwnProperty(key)) {
    registers[key] = false;
  }

  return {
    ready: () => {
      registers[key] = true;

      if (areRegistersReady() && waitForReadyQueue.size > 0) {
        waitForReadyQueue.forEach((queuePayload, queueEvent) => {
          publishEvent(queueEvent, queuePayload);
        });
        waitForReadyQueue.clear();
      }
    },
  };
}

/**
 * This functions attempts to automatically determine if the user can be tracked if the
 * customer privacy API is available. If not, it will default to false.
 */
function shopifyCanTrack(): boolean {
  try {
    return window.Shopify.customerPrivacy.analyticsProcessingAllowed();
  } catch (e) {}
  return false;
}

function messageOnError(field: string, envVar: string) {
  return `[h2:error:Analytics.Provider] - ${field} is required. Make sure ${envVar} is defined in your environment variables. See https://h2o.fyi/analytics/consent to learn how to setup environment variables in the Shopify admin.`;
}

function AnalyticsProvider({
  canTrack: customCanTrack,
  cart: currentCart,
  children,
  consent,
  customData = {},
  shop: shopProp = null,
  cookieDomain,
}: AnalyticsProviderProps): JSX.Element {
  const listenerSet = useRef(false);
  const {shop} = useShopAnalytics(shopProp);
  const [analyticsLoaded, setAnalyticsLoaded] = useState(
    customCanTrack ? true : false,
  );
  const [carts, setCarts] = useState<Carts>({cart: null, prevCart: null});
  const [canTrack, setCanTrack] = useState<() => boolean>(
    customCanTrack ? () => customCanTrack : () => shopifyCanTrack,
  );

  // eslint-disable-next-line no-extra-boolean-cast
  if (!!shop) {
    // If mock shop is used, log error instead of throwing
    if (/\/68817551382$/.test(shop.shopId)) {
      warnOnce(
        '[h2:error:Analytics.Provider] - Mock shop is used. Analytics will not work properly.',
      );
    } else {
      if (!consent.checkoutDomain) {
        const errorMsg = messageOnError(
          'consent.checkoutDomain',
          'PUBLIC_CHECKOUT_DOMAIN',
        );
        errorOnce(errorMsg);
      }

      if (!consent.storefrontAccessToken) {
        const errorMsg = messageOnError(
          'consent.storefrontAccessToken',
          'PUBLIC_STOREFRONT_API_TOKEN',
        );
        errorOnce(errorMsg);
      }

      if (!consent?.country) {
        consent.country = 'US';
      }

      if (!consent?.language) {
        consent.language = 'EN';
      }

      if (consent.withPrivacyBanner === undefined) {
        consent.withPrivacyBanner = false;
      }
    }
  }

  const value = useMemo<AnalyticsContextValue>(() => {
    return {
      canTrack,
      ...carts,
      customData,
      publish: canTrack() ? publish : () => {},
      shop,
      subscribe,
      register,
      customerPrivacy: getCustomerPrivacy(),
      privacyBanner: getPrivacyBanner(),
    };
  }, [
    analyticsLoaded,
    canTrack,
    carts,
    carts.cart?.updatedAt,
    carts.prevCart,
    publish,
    subscribe,
    customData,
    shop,
    register,
    JSON.stringify(registers),
    getCustomerPrivacy,
    getPrivacyBanner,
  ]);

  return (
    <AnalyticsContext.Provider value={value}>
      {children}
      {!!shop && <AnalyticsPageView />}
      {!!shop && !!currentCart && (
        <CartAnalytics cart={currentCart} setCarts={setCarts} />
      )}
      {!!shop && consent.checkoutDomain && (
        <ShopifyAnalytics
          consent={consent}
          onReady={() => {
            listenerSet.current = true;
            setAnalyticsLoaded(true);
            setCanTrack(
              customCanTrack ? () => customCanTrack : () => shopifyCanTrack,
            );
          }}
          domain={cookieDomain}
        />
      )}
      {!!shop && <PerfKit shop={shop} />}
    </AnalyticsContext.Provider>
  );
}

export function useAnalytics(): AnalyticsContextValue {
  const analyticsContext = useContext(AnalyticsContext);
  if (!analyticsContext) {
    throw new Error(
      `[h2:error:useAnalytics] 'useAnalytics()' must be a descendent of <AnalyticsProvider/>`,
    );
  }
  return analyticsContext;
}

/**
 * A hook that resolves the shop analytics that could have been deferred
 * and returns the shop analytics.
 */
function useShopAnalytics(shopProp: AnalyticsProviderProps['shop']): {
  shop: ShopAnalytics | null;
} {
  const [shop, setShop] =
    useState<Awaited<AnalyticsProviderProps['shop']>>(null);

  // resolve the shop analytics that could have been deferred
  useEffect(() => {
    Promise.resolve(shopProp).then(setShop);
    return () => {};
  }, [setShop, shopProp]);

  return {shop};
}

type ShopAnalyticsProps = {
  /**
   * The storefront client instance created by [`createStorefrontClient`](docs/api/hydrogen/2025-04/utilities/createstorefrontclient).
   */
  storefront: Storefront;
  /**
   * The `PUBLIC_STOREFRONT_ID` generated by Oxygen in the environment variable.
   */
  publicStorefrontId: string;
};

export async function getShopAnalytics({
  storefront,
  publicStorefrontId = '0',
}: ShopAnalyticsProps): Promise<ShopAnalytics | null> {
  return storefront
    .query(SHOP_QUERY, {
      cache: storefront.CacheLong(),
    })
    .then(({shop, localization}: {shop: Shop; localization: Localization}) => {
      return {
        shopId: shop.id,
        acceptedLanguage: localization.language.isoCode,
        currency: localization.country.currency.isoCode,
        hydrogenSubchannelId: publicStorefrontId,
      };
    });
}

const SHOP_QUERY = `#graphql
  query ShopData(
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    shop {
      id
    }
    localization {
      country {
        currency {
          isoCode
        }
      }
      language {
        isoCode
      }
    }
  }
` as const;

export const Analytics = {
  CartView: AnalyticsCartView,
  CollectionView: AnalyticsCollectionView,
  CustomView: AnalyticsCustomView,
  ProductView: AnalyticsProductView,
  Provider: AnalyticsProvider,
  SearchView: AnalyticsSearchView,
};

type DefaultCart = Promise<CartReturn | null> | CartReturn | null;

export type AnalyticsContextValueForDoc<UserCart> = {
  /** A function to tell you the current state of if the user can be tracked by analytics. Defaults to Customer Privacy API's `window.Shopify.customerPrivacy.analyticsProcessingAllowed()`. */
  canTrack?: () => boolean;
  /** The current cart state. You can overwrite the type by passing a generic */
  cart?: UserCart | DefaultCart;
  /** The custom data passed in from the `AnalyticsProvider`. */
  customData?: Record<string, unknown>;
  /** The previous cart state. You can overwrite the type by passing a generic */
  prevCart?: UserCart | DefaultCart;
  /** A function to publish an analytics event. */
  publish?: AnalyticsContextPublishForDoc;
  /** A function to register with the analytics provider. It holds the first browser load events until all registered key has executed the supplied `ready` function. [See example register  usage](/docs/api/hydrogen/2025-04/hooks/useanalytics#example-useanalytics.register). */
  register?: (key: string) => {ready: () => void};
  /** The shop configuration required to publish events to Shopify. */
  shop?: Promise<ShopAnalytics | null> | ShopAnalytics | null;
  /** A function to subscribe to analytics events. */
  subscribe?: AnalyticsContextSubscribeForDoc;
};

type PublishPageView = (event: 'page_viewed', payload: PageViewPayload) => void;
type PublishProductView = (
  event: 'product_viewed',
  payload: ProductViewPayload,
) => void;
type PublishCollectionView = (
  event: 'collection_viewed',
  payload: CollectionViewPayload,
) => void;
type PublishCartView = (event: 'cart_viewed', payload: CartViewPayload) => void;
type PublishSearchView = (
  event: 'search_viewed',
  payload: SearchViewPayload,
) => void;
type PublishCartUpdated = (
  event: 'cart_updated',
  payload: CartUpdatePayload,
) => void;
type PublishProductAddedToCart = (
  event: 'product_added_to_cart',
  payload: CartLineUpdatePayload,
) => void;
type PublishProductRemovedFromCart = (
  event: 'product_removed_from_cart',
  payload: CartLineUpdatePayload,
) => void;
type PublishCustomEvent = (
  event: `custom_${string}`,
  payload: OtherData,
) => void;

export type AnalyticsContextPublishForDoc =
  | PublishPageView
  | PublishProductView
  | PublishCollectionView
  | PublishCartView
  | PublishSearchView
  | PublishCartUpdated
  | PublishProductAddedToCart
  | PublishProductRemovedFromCart
  | PublishCustomEvent;

type SubscribePageView = (
  event: 'page_viewed',
  callback: (payload: PageViewPayload) => void,
) => void;
type SubscribeProductView = (
  event: 'product_viewed',
  callback: (payload: ProductViewPayload) => void,
) => void;
type SubscribeCollectionView = (
  event: 'collection_viewed',
  callback: (payload: CollectionViewPayload) => void,
) => void;
type SubscribeCartView = (
  event: 'cart_viewed',
  callback: (payload: CartViewPayload) => void,
) => void;
type SubscribeSearchView = (
  event: 'search_viewed',
  callback: (payload: SearchViewPayload) => void,
) => void;
type SubscribeCartUpdated = (
  event: 'cart_updated',
  callback: (payload: CartUpdatePayload) => void,
) => void;
type SubscribeProductAddedToCart = (
  event: 'product_added_to_cart',
  callback: (payload: CartLineUpdatePayload) => void,
) => void;
type SubscribeProductRemovedFromCart = (
  event: 'product_removed_from_cart',
  callback: (payload: CartLineUpdatePayload) => void,
) => void;
type SubscribeCustomEvent = (
  event: `custom_${string}`,
  callback: (payload: OtherData) => void,
) => void;

export type AnalyticsContextSubscribeForDoc =
  | SubscribePageView
  | SubscribeProductView
  | SubscribeCollectionView
  | SubscribeCartView
  | SubscribeSearchView
  | SubscribeCartUpdated
  | SubscribeProductAddedToCart
  | SubscribeProductRemovedFromCart
  | SubscribeCustomEvent;
