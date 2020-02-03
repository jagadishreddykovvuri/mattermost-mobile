// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {PureComponent} from 'react';
import {Navigation} from 'react-native-navigation';
import PropTypes from 'prop-types';
import {intlShape} from 'react-intl';
import {
    ActivityIndicator,
    DeviceEventEmitter,
    Image,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    SafeAreaView,
    StatusBar,
    StyleSheet,
    Text,
    TextInput,
    TouchableWithoutFeedback,
    View,
} from 'react-native';
import Button from 'react-native-button';
import RNFetchBlob from 'rn-fetch-blob';

import merge from 'deepmerge';

import {Client4} from 'mattermost-redux/client';

import ErrorText from 'app/components/error_text';
import FormattedText from 'app/components/formatted_text';
import fetchConfig from 'app/init/fetch';
import mattermostBucket from 'app/mattermost_bucket';
import {GlobalStyles} from 'app/styles';
import {checkUpgradeType, isUpgradeAvailable} from 'app/utils/client_upgrade';
import {isValidUrl, stripTrailingSlashes} from 'app/utils/url';
import {preventDoubleTap} from 'app/utils/tap';
import tracker from 'app/utils/time_tracker';
import {t} from 'app/utils/i18n';
import {changeOpacity} from 'app/utils/theme';
import {resetToChannel, goToScreen} from 'app/actions/navigation';

import telemetry from 'app/telemetry';

import LocalConfig from 'assets/config';

export default class SelectServer extends PureComponent {
    static propTypes = {
        actions: PropTypes.shape({
            getPing: PropTypes.func.isRequired,
            handleServerUrlChanged: PropTypes.func.isRequired,
            handleSuccessfulLogin: PropTypes.func.isRequired,
            scheduleExpiredNotification: PropTypes.func.isRequired,
            loadConfigAndLicense: PropTypes.func.isRequired,
            login: PropTypes.func.isRequired,
            resetPing: PropTypes.func.isRequired,
            setLastUpgradeCheck: PropTypes.func.isRequired,
            setServerVersion: PropTypes.func.isRequired,
        }).isRequired,
        allowOtherServers: PropTypes.bool,
        config: PropTypes.object,
        currentVersion: PropTypes.string,
        hasConfigAndLicense: PropTypes.bool.isRequired,
        latestVersion: PropTypes.string,
        license: PropTypes.object,
        minVersion: PropTypes.string,
        serverUrl: PropTypes.string.isRequired,
    };

    static contextTypes = {
        intl: intlShape.isRequired,
    };

    constructor(props) {
        super(props);

        this.state = {
            connected: false,
            connecting: false,
            error: null
        };

        this.cancelPing = null;
    }

    componentDidMount() {
        this.navigationEventListener = Navigation.events().bindComponent(this);

        const {allowOtherServers, serverUrl} = this.props;
        if (!allowOtherServers && serverUrl) {
            // If the app is managed or AutoSelectServerUrl is true in the Config, the server url is set and the user can't change it
            // we automatically trigger the ping to move to the next screen
            this.handleConnect();
        }

        if (Platform.OS === 'android') {
            Keyboard.addListener('keyboardDidHide', this.handleAndroidKeyboard);
        }

        this.certificateListener = DeviceEventEmitter.addListener('RNFetchBlobCertificate', this.selectCertificate);

        telemetry.end(['start:select_server_screen']);
        telemetry.save();
        this.handleConnect();
    }

    componentDidUpdate(prevProps, prevState) {
        if (this.state.connected && this.props.hasConfigAndLicense && !(prevState.connected && prevProps.hasConfigAndLicense)) {
            if (LocalConfig.EnableMobileClientUpgrade) {
                this.props.actions.setLastUpgradeCheck();
                const {currentVersion, minVersion, latestVersion} = this.props;
                const upgradeType = checkUpgradeType(currentVersion, minVersion, latestVersion);
                if (isUpgradeAvailable(upgradeType)) {
                    this.handleShowClientUpgrade(upgradeType);
                } else {
                    this.handleLoginOptions(this.props);
                }
            } else {
                this.handleLoginOptions(this.props);
            }
        }
    }

    componentWillUnmount() {
        if (Platform.OS === 'android') {
            Keyboard.removeListener('keyboardDidHide', this.handleAndroidKeyboard);
        }

        this.certificateListener.remove();

        this.navigationEventListener.remove();
    }

    componentDidDisappear() {
        this.setState({
            connected: false,
        });
    }

    blur = () => {
        if (this.textInput) {
            this.textInput.blur();
        }
    };

    getUrl = () => {
        const urlParse = require('url-parse');
        let preUrl = urlParse('https://mattermost.ib-developers.net', true);

        if (!preUrl.host || preUrl.protocol === 'file:') {
            preUrl = urlParse('https://' + stripTrailingSlashes('https://mattermost.ib-developers.net'), true);
        }

        if (preUrl.protocol === 'http:') {
            preUrl.protocol = 'https:';
        }

        return stripTrailingSlashes(preUrl.protocol + '//' + preUrl.host + preUrl.pathname);
    };

    goToNextScreen = (screen, title, passProps = {}, navOptions = {}) => {
        const defaultOptions = {
            popGesture: !LocalConfig.AutoSelectServerUrl,
            topBar: {
                visible: !LocalConfig.AutoSelectServerUrl,
                height: LocalConfig.AutoSelectServerUrl ? 0 : null,
            },
        };
        const options = merge(defaultOptions, navOptions);

        goToScreen(screen, title, passProps, options);
    };

    handleAndroidKeyboard = () => {
        this.blur();
    };

    handleConnect = preventDoubleTap(async () => {
        const url = this.getUrl();

        Keyboard.dismiss();

        if (this.state.connecting || this.state.connected) {
            this.cancelPing();

            return;
        }

        if (!isValidUrl(url)) {
            this.setState({
                error: {
                    intl: {
                        id: t('mobile.server_url.invalid_format'),
                        defaultMessage: 'URL must start with http:// or https://',
                    },
                },
            });

            return;
        }

        if (LocalConfig.ExperimentalClientSideCertEnable && Platform.OS === 'ios') {
            RNFetchBlob.cba.selectCertificate((certificate) => {
                if (certificate) {
                    mattermostBucket.setPreference('cert', certificate);
                    window.fetch = new RNFetchBlob.polyfill.Fetch({
                        auto: true,
                        certificate,
                    }).build();
                    this.pingServer(url);
                }
            });
        } else {
            this.pingServer(url);
        }
    });

    handleLoginOptions = (props = this.props) => {
        const {formatMessage} = this.context.intl;
        const {config, license} = props;
        const samlEnabled = config.EnableSaml === 'true' && license.IsLicensed === 'true' && license.SAML === 'true';
        const gitlabEnabled = config.EnableSignUpWithGitLab === 'true';
        const o365Enabled = config.EnableSignUpWithOffice365 === 'true' && license.IsLicensed === 'true' && license.Office365OAuth === 'true';

        let options = 0;
        if (samlEnabled || gitlabEnabled || o365Enabled) {
            options += 1;
        }

        let screen;
        let title;
        if (options) {
            screen = 'LoginOptions';
            title = formatMessage({id: 'mobile.routes.loginOptions', defaultMessage: 'Login Chooser'});
        } else {
            screen = 'Login';
            title = formatMessage({id: 'mobile.routes.login', defaultMessage: 'Login'});
        }

        this.props.actions.resetPing();

        if (Platform.OS === 'ios') {
            if (config.ExperimentalClientSideCertEnable === 'true' && config.ExperimentalClientSideCertCheck === 'primary') {
                // log in automatically and send directly to the channel screen
                this.loginWithCertificate();
                return;
            }

            setTimeout(() => {
                this.goToNextScreen(screen, title);
            }, 350);
        } else {
            this.goToNextScreen(screen, title);
        }
    };

    handleShowClientUpgrade = (upgradeType) => {
        const {formatMessage} = this.context.intl;
        const screen = 'ClientUpgrade';
        const title = formatMessage({id: 'mobile.client_upgrade', defaultMessage: 'Client Upgrade'});
        const passProps = {
            closeAction: this.handleLoginOptions,
            upgradeType,
        };
        const options = {
            statusBar: {
                visible: false,
            },
        };

        this.goToNextScreen(screen, title, passProps, options);
    };


    loginWithCertificate = async () => {
        tracker.initialLoad = Date.now();

        await this.props.actions.login('credential', 'password');
        await this.props.actions.handleSuccessfulLogin();
        this.scheduleSessionExpiredNotification();

        resetToChannel();
    };

    pingServer = (url, retryWithHttp = true) => {
        const {
            getPing,
            handleServerUrlChanged,
            loadConfigAndLicense,
            setServerVersion,
        } = this.props.actions;

        this.setState({
            connected: false,
            connecting: true,
            error: null,
        });

        Client4.setUrl(url);
        handleServerUrlChanged(url);

        let cancel = false;
        this.cancelPing = () => {
            cancel = true;

            this.setState({
                connected: false,
                connecting: false,
            });

            this.cancelPing = null;
        };

        getPing().then((result) => {
            if (cancel) {
                return;
            }

            if (result.error && retryWithHttp) {
                this.pingServer(url.replace('https:', 'http:'), false);
                return;
            }

            if (!result.error) {
                loadConfigAndLicense();
                setServerVersion(Client4.getServerVersion());
            }

            this.setState({
                connected: !result.error,
                connecting: false,
                error: result.error,
            });
        }).catch(() => {
            if (cancel) {
                return;
            }

            this.setState({
                connecting: false,
            });
        });
    };

    scheduleSessionExpiredNotification = () => {
        const {intl} = this.context;
        const {actions} = this.props;

        actions.scheduleExpiredNotification(intl);
    };

    selectCertificate = () => {
        const url = this.getUrl();
        RNFetchBlob.cba.selectCertificate((certificate) => {
            if (certificate) {
                mattermostBucket.setPreference('cert', certificate);
                fetchConfig().then(() => {
                    this.pingServer(url, true);
                });
            }
        });
    };

    showStartButton=()=>{
        const {
            connected,
            connecting
        } = this.state;
        if (connected || connecting) return false;
        return true;
    }

    render() {
        const {formatMessage} = this.context.intl;
        const {allowOtherServers} = this.props;
        const {
            connected,
            connecting,
            error,
            url,
        } = this.state;

        let loader;
        if (connected || connecting) {
            loader = (
                <ActivityIndicator
                    animating={true}
                    size='small'
                    style={style.connectingIndicator}
                />
            );
        } 
        let statusStyle = 'dark-content';
        if (Platform.OS === 'android') {
            statusStyle = 'light-content';
        }

        const inputDisabled = !allowOtherServers || connected || connecting;
        const inputStyle = [GlobalStyles.inputBox];
        if (inputDisabled) {
            inputStyle.push(style.disabledInput);
        }

        return (
            <SafeAreaView
                style={style.container}
            >
                <KeyboardAvoidingView
                    behavior='padding'
                    style={style.container}
                    keyboardVerticalOffset={0}
                    enabled={Platform.OS === 'ios'}
                >
                    <StatusBar barStyle={statusStyle}/>
                    <TouchableWithoutFeedback
                        onPress={this.blur}
                        accessible={false}
                    >
                        <View style={[GlobalStyles.container, GlobalStyles.signupContainer]}>
                            {loader}
                            {this.showStartButton() && <>
                                <Button
                                    onPress={this.handleConnect}
                                    containerStyle={[GlobalStyles.signupButton, style.connectButton]}
                                >
                                    <Text style={GlobalStyles.signupButtonText}>
                                        <FormattedText
                                            id='mobile.components.select_server_view.start'
                                            defaultMessage='Start'
                                        />
                                    </Text>
                                </Button>
                                <ErrorText error={error}/>
                            </>}
                        </View>
                    </TouchableWithoutFeedback>
                </KeyboardAvoidingView>
            </SafeAreaView>
        );
    }
}

const style = StyleSheet.create({
    container: {
        flex: 1,
    },
    disabledInput: {
        backgroundColor: '#e3e3e3',
    },
    connectButton: {
        alignItems: 'center',
    },
    connectingIndicator: {
        marginRight: 5,
    },
});
