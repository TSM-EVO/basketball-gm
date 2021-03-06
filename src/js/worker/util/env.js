// @flow

import type {Env} from '../../common/types';

// Default values, to be overwritten on initialization by global variables from ui
const env: Env = {
    enableLogging: false,
    heartbeatID: '',
    inCordova: false,
    tld: 'com',
    fromLocalStorage: {},
    useSharedWorker: false,
};

export default env;
